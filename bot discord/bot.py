# AETHORIA BOT — Code Complet Mis à Jour
# Salons Permanents (/salon) + Dashboard Dynamic + Tickets + Histoire Infinie

import asyncio
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import threading
import aiohttp
import discord
from discord import app_commands
from discord.ext import tasks
from dotenv import load_dotenv

load_dotenv()

# ============================================================
# SERVEUR WEB — DISCLOUD / REPLIT / HEROKU
# ============================================================


class HealthHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Aethoria Bot is online!")

    def log_message(self, format, *args):
        pass


def start_web_server():
    port = int(os.environ.get("PORT", 10000))
    server = HTTPServer(("0.0.0.0", port), HealthHandler)
    print(f"🌐 Serveur web lancé sur le port {port}")
    server.serve_forever()


threading.Thread(target=start_web_server, daemon=True).start()

# ============================================================
# CONFIGURATION GÉNÉRALE
# ============================================================

TOKEN = os.getenv("DISCORD_TOKEN")
FICHIER_DONNEES = "donnees.json"

CATEGORIE_TICKETS = "🎫・TICKETS"

# Remplace par l'ID de la catégorie dans laquelle les salons permanents seront créés
ID_CATEGORIE_PERMANENTE = 1538975841957052598  # 👈 Met l'ID de ta catégorie ici

# IDs des rôles Staff pour les Pings et accès aux tickets
ROLE_ADMIN_ID = 1515719685478551742
ROLE_MODERATEUR_ID = 1515718776367354079

# Salon Histoire Infinie
CHANNEL_JEU_ID = 1541006278191747182
LIMITE_MOTS = 30

# Serveurs Minecraft
SERVER_IP_JAVA = "aethoria.omgcraft.fr"
SERVER_IP_BEDROCK = "Aethoria.aternos.me"

# ============================================================
# INTENTS & INITIALISATION
# ============================================================

intents = discord.Intents.default()
intents.members = True
intents.message_content = True

bot = discord.Client(intents=intents)
tree = app_commands.CommandTree(bot)

# ============================================================
# GESTION DES DONNÉES ET SAUVEGARDE
# ============================================================


def donnees_par_defaut():
    return {
        "jeu_histoire": {"mots": [], "dernier_joueur_id": None},
        "tickets_config": {
            "channel_logs_id": None,
            "tickets_actifs": {},
        },
        "tableau_bord": {"channel_id": None, "message_id": None},
        "statistiques": {
            "aujourdhui_plus": 0,
            "aujourdhui_moins": 0,
            "semaine_plus": 0,
            "semaine_moins": 0,
            "record_membres": 0,
            "historique_7j": {},
        },
    }


def charger_donnees():
    if not os.path.exists(FICHIER_DONNEES):
        return donnees_par_defaut()

    try:
        with open(FICHIER_DONNEES, "r", encoding="utf-8") as fichier:
            donnees_chargees = json.load(fichier)

        defaut = donnees_par_defaut()
        for cle, valeur in defaut.items():
            donnees_chargees.setdefault(cle, valeur)

        return donnees_chargees
    except Exception as erreur:
        print(f"⚠️ Erreur chargement données : {erreur}")
        return donnees_par_defaut()


donnees = charger_donnees()


def sauvegarder():
    try:
        fichier_temp = FICHIER_DONNEES + ".tmp"
        with open(fichier_temp, "w", encoding="utf-8") as fichier:
            json.dump(donnees, fichier, indent=4, ensure_ascii=False)
        os.replace(fichier_temp, FICHIER_DONNEES)
    except Exception as erreur:
        print(f"❌ Erreur sauvegarde : {erreur}")


def peut_gerer(interaction: discord.Interaction):
    return (
        interaction.user.guild_permissions.manage_channels
        or interaction.user.guild_permissions.administrator
    )


async def envoyer_log_ticket(guild, embed):
    log_id = donnees.get("tickets_config", {}).get("channel_logs_id")
    if not log_id:
        return
    log_channel = guild.get_channel(log_id)
    if log_channel:
        try:
            await log_channel.send(embed=embed)
        except Exception as e:
            print(f"❌ Erreur envoi log ticket : {e}")


# ============================================================
# TABLEAU DE BORD DYNAMIQUE
# ============================================================


async def obtenir_stats_minecraft(ip):
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"https://api.mcsrvstat.us/2/{ip}", timeout=5
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    online = data.get("online", False)
                    joueurs = data.get("players", {}).get("online", 0)
                    max_joueurs = data.get("players", {}).get("max", 0)
                    return online, joueurs, max_joueurs
    except Exception:
        pass
    return False, 0, 0


@tasks.loop(minutes=1)
async def update_tableau_de_board():
    board_config = donnees.get("tableau_bord", {})
    channel_id = board_config.get("channel_id")
    message_id = board_config.get("message_id")

    if not channel_id or not message_id:
        return

    guild = bot.guilds[0] if bot.guilds else None
    if not guild:
        return

    channel = guild.get_channel(channel_id)
    if not channel:
        return

    try:
        message = await channel.fetch_message(message_id)
    except Exception:
        return

    total_membres = guild.member_count
    stats = donnees.setdefault("statistiques", {})

    aujourdhui_plus = stats.get("aujourdhui_plus", 0)
    aujourdhui_moins = stats.get("aujourdhui_moins", 0)
    semaine_plus = stats.get("semaine_plus", 0)
    semaine_moins = stats.get("semaine_moins", 0)

    record_membres = stats.get("record_membres", total_membres)
    if total_membres > record_membres:
        record_membres = total_membres
        stats["record_membres"] = record_membres
        sauvegarder()

    java_online, java_players, java_max = await obtenir_stats_minecraft(
        SERVER_IP_JAVA
    )
    java_statut = "🟢" if java_online else "🔴"

    bedrock_online, bedrock_players, bedrock_max = await obtenir_stats_minecraft(
        SERVER_IP_BEDROCK
    )
    bedrock_statut = "🟢" if bedrock_online else "🔴"

    historique = stats.setdefault("historique_7j", {})
    date_aujourdhui = datetime.now(timezone.utc).strftime("%m-%d")
    historique[date_aujourdhui] = total_membres

    cles_triees = sorted(historique.keys())[-7:]
    lignes_evolution = [f"{date} : {historique[date]}" for date in cles_triees]
    texte_evolution = (
        "\n".join(lignes_evolution)
        if lignes_evolution
        else f"{date_aujourdhui} : {total_membres}"
    )

    contenu_message = (
        "📈 **STATISTIQUES AETHORIA**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "👥 **DISCORD**\n"
        f"• Membres actuels : {total_membres}\n"
        f"• Aujourd'hui : +{aujourdhui_plus} / -{aujourdhui_moins}\n"
        f"• Cette semaine : +{semaine_plus} / -{semaine_moins}\n"
        f"• Record de membres : {record_membres}\n\n"
        "⛏️ **MINECRAFT**\n"
        f"• Java : {java_players}/{java_max} {java_statut}\n"
        f"• Bedrock : {bedrock_players}/{bedrock_max} {bedrock_statut}\n\n"
        "📊 **ÉVOLUTION DES MEMBRES — 7 JOURS**\n"
        f"{texte_evolution}\n\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "*Mise à jour automatique toutes les minutes*"
    )

    await message.edit(content=contenu_message, embed=None)


@tree.command(
    name="setup_tableau_de_bord",
    description="[STAFF] Initialiser le message du tableau de bord",
)
async def setup_tableau_de_bord(interaction: discord.Interaction):
    if not peut_gerer(interaction):
        await interaction.response.send_message(
            "❌ Permission insuffisante.", ephemeral=True
        )
        return

    msg = await interaction.channel.send("⌛ *Initialisation du tableau de bord...*")

    donnees["tableau_bord"] = {
        "channel_id": interaction.channel.id,
        "message_id": msg.id,
    }
    sauvegarder()

    if not update_tableau_de_board.is_running():
        update_tableau_de_board.start()

    await interaction.response.send_message(
        "✅ Tableau de bord créé et configuré dans ce salon !", ephemeral=True
    )


# ============================================================
# ÉVÉNEMENTS MEMBRES (POUR LES STATISTIQUES DU DASHBOARD)
# ============================================================


@bot.event
async def on_member_join(member):
    if member.bot:
        return

    stats = donnees.setdefault("statistiques", {})
    stats["aujourdhui_plus"] = stats.get("aujourdhui_plus", 0) + 1
    stats["semaine_plus"] = stats.get("semaine_plus", 0) + 1
    sauvegarder()


@bot.event
async def on_member_remove(member):
    if member.bot:
        return

    stats = donnees.setdefault("statistiques", {})
    stats["aujourdhui_moins"] = stats.get("aujourdhui_moins", 0) + 1
    stats["semaine_moins"] = stats.get("semaine_moins", 0) + 1
    sauvegarder()

# ============================================================
# SYSTÈME DE TICKETS DÉTAILLÉ
# ============================================================


class MenuChoixTicket(discord.ui.Select):

    def __init__(self):
        options = [
            discord.SelectOption(
                label="Problème Jeu — Java",
                description="Un souci ou bug sur la version Java (PC)",
                emoji="💻",
                value="java",
            ),
            discord.SelectOption(
                label="Problème Jeu — Bedrock",
                description="Un souci ou bug sur Bedrock",
                emoji="📱",
                value="bedrock",
            ),
            discord.SelectOption(
                label="Signalement",
                description="Signaler un joueur ou un comportement",
                emoji="⚠️",
                value="signalement",
            ),
            discord.SelectOption(
                label="Problème avec un Staff",
                description="Ticket privé géré UNIQUEMENT par l'Administration",
                emoji="🛡️",
                value="staff_problem",
            ),
            discord.SelectOption(
                label="Contestation de Sanction",
                description="Contester un ban, mute ou warn",
                emoji="🔨",
                value="sanction",
            ),
            discord.SelectOption(
                label="Recrutement",
                description="Postuler pour l'équipe du staff",
                emoji="📝",
                value="recrutement",
            ),
            discord.SelectOption(
                label="Notation",
                description="Laisser une note ou un avis sur le serveur",
                emoji="⭐",
                value="notation",
            ),
            discord.SelectOption(
                label="Autre",
                description="Autre demande spécifique",
                emoji="📩",
                value="autre",
            ),
        ]
        super().__init__(
            placeholder="Sélectionne la nature de ton ticket...",
            min_values=1,
            max_values=1,
            options=options,
            custom_id="select_nature_ticket",
        )

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)

        type_ticket = self.values[0]
        membre = interaction.user

        log_id = donnees.get("tickets_config", {}).get("channel_logs_id")
        if not log_id:
            await interaction.followup.send(
                "❌ Le salon de logs n'a pas encore été configuré par le Staff (`/setup_logs_tickets`).",
                ephemeral=True,
            )
            return

        log_channel = interaction.guild.get_channel(log_id)
        if not log_channel:
            await interaction.followup.send(
                "❌ Le salon des logs est introuvable.", ephemeral=True
            )
            return

        role_admin = interaction.guild.get_role(ROLE_ADMIN_ID)
        role_modo = interaction.guild.get_role(ROLE_MODERATEUR_ID)

        mention_admin = role_admin.mention if role_admin else f"<@&{ROLE_ADMIN_ID}>"
        mention_modo = role_modo.mention if role_modo else f"<@&{ROLE_MODERATEUR_ID}>"

        if type_ticket in ["staff_problem", "sanction"]:
            ping_content = mention_admin
        else:
            ping_content = f"{mention_admin} {mention_modo}"

        embed_log = discord.Embed(
            title="📥 Nouvelle demande de Ticket",
            description=f"Le membre {membre.mention} demande l'ouverture d'un ticket.",
            color=0xF1C40F,
            timestamp=datetime.now(timezone.utc),
        )
        embed_log.add_field(
            name="👤 Demandeur",
            value=f"{membre.mention} (`{membre.id}`)",
            inline=True,
        )
        embed_log.add_field(
            name="🏷️ Type de Ticket",
            value=f"`{type_ticket.upper()}`",
            inline=True,
        )
        embed_log.set_footer(text="En attente de validation par l'équipe...")

        view_valider = ValiderTicketView(
            membre_id=membre.id, type_ticket=type_ticket
        )

        await log_channel.send(
            content=ping_content,
            embed=embed_log,
            view=view_valider,
            allowed_mentions=discord.AllowedMentions(roles=True),
        )

        await interaction.followup.send(
            "⏳ Ta demande de ticket a été envoyée au staff ! Tu seras notifié dès qu'elle sera acceptée.",
            ephemeral=True,
        )


class ValiderTicketView(discord.ui.View):

    def __init__(self, membre_id: int = 0, type_ticket: str = ""):
        super().__init__(timeout=None)
        self.membre_id = membre_id
        self.type_ticket = type_ticket

    @discord.ui.button(
        label="Accepter",
        style=discord.ButtonStyle.success,
        emoji="✅",
        custom_id="bouton_accepter_ticket",
    )
    async def accepter(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        if not peut_gerer(interaction):
            await interaction.response.send_message(
                "❌ Seul le staff peut valider les tickets.", ephemeral=True
            )
            return

        await interaction.response.defer(ephemeral=True)

        guild = interaction.guild
        embed_log = interaction.message.embeds[0]

        if not self.membre_id and embed_log.fields:
            user_id_str = (
                embed_log.fields[0].value.split("`")[1]
                if "`" in embed_log.fields[0].value
                else "0"
            )
            self.membre_id = int(user_id_str)
            self.type_ticket = (
                embed_log.fields[1].value.replace("`", "").lower()
            )

        membre = guild.get_member(self.membre_id)
        if not membre:
            await interaction.followup.send(
                "❌ Le joueur est introuvable ou a quitté le serveur.",
                ephemeral=True,
            )
            return

        categorie = discord.utils.get(guild.categories, name=CATEGORIE_TICKETS)
        if not categorie:
            categorie = await guild.create_category(CATEGORIE_TICKETS)

        nom_salon = f"{self.type_ticket}-{membre.name.lower().replace(' ', '-')}"

        permissions = {
            guild.default_role: discord.PermissionOverwrite(
                read_messages=False
            ),
            membre: discord.PermissionOverwrite(
                read_messages=True,
                send_messages=True,
                read_message_history=True,
            ),
            guild.me: discord.PermissionOverwrite(
                read_messages=True, send_messages=True, manage_channels=True
            ),
        }

        role_modo = guild.get_role(ROLE_MODERATEUR_ID)
        role_admin = guild.get_role(ROLE_ADMIN_ID)

        if self.type_ticket in ["staff_problem", "sanction"]:
            if role_modo:
                permissions[role_modo] = discord.PermissionOverwrite(
                    read_messages=False
                )
            if role_admin:
                permissions[role_admin] = discord.PermissionOverwrite(
                    read_messages=True,
                    send_messages=True,
                    read_message_history=True,
                )
        else:
            if role_modo:
                permissions[role_modo] = discord.PermissionOverwrite(
                    read_messages=True,
                    send_messages=True,
                    read_message_history=True,
                )
            if role_admin:
                permissions[role_admin] = discord.PermissionOverwrite(
                    read_messages=True,
                    send_messages=True,
                    read_message_history=True,
                )

        salon_ticket = await guild.create_text_channel(
            name=nom_salon, category=categorie, overwrites=permissions
        )

        date_ouverture = datetime.now(timezone.utc)
        donnees.setdefault("tickets_config", {}).setdefault(
            "tickets_actifs", {}
        )[str(salon_ticket.id)] = {
            "owner_id": membre.id,
            "type": self.type_ticket,
            "ouvert_a": date_ouverture.isoformat(),
        }
        sauvegarder()

        for child in self.children:
            child.disabled = True

        embed_log.color = 0x2ECC71
        embed_log.set_footer(
            text=f"✅ Ticket accepté par {interaction.user.display_name} -> #{nom_salon}"
        )
        await interaction.message.edit(embed=embed_log, view=self)

        embed_ouvert = discord.Embed(
            title="📥 Ticket Ouvert",
            color=0x2ECC71,
        )
        embed_ouvert.add_field(
            name="👤 Auteur",
            value=f"{membre.mention} (`{membre.id}`)",
            inline=True,
        )
        embed_ouvert.add_field(
            name="🏷️ Type",
            value=f"`{self.type_ticket.upper()}`",
            inline=True,
        )
        embed_ouvert.add_field(
            name="💬 Salon",
            value=salon_ticket.mention,
            inline=False,
        )
        embed_ouvert.set_footer(text=f"ID Ticket : {salon_ticket.id}")
        await envoyer_log_ticket(guild, embed_ouvert)

        embed_welcome = discord.Embed(
            title=f"🎫 Ticket {self.type_ticket.upper()} — {membre.display_name}",
            description=f"Bonjour {membre.mention} !\nTon ticket a été accepté par {interaction.user.mention}.\n\nExplique ton problème ici.",
            color=0x3498DB,
        )
        await salon_ticket.send(embed=embed_welcome, view=FermerTicketView())

        await interaction.followup.send(
            f"✅ Ticket accepté ! Salon créé : {salon_ticket.mention}",
            ephemeral=True,
        )

    @discord.ui.button(
        label="Refuser",
        style=discord.ButtonStyle.danger,
        emoji="❌",
        custom_id="bouton_refuser_ticket",
    )
    async def refuser(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        if not peut_gerer(interaction):
            await interaction.response.send_message(
                "❌ Seul le staff peut refuser les tickets.", ephemeral=True
            )
            return

        await interaction.response.defer(ephemeral=True)

        embed_log = interaction.message.embeds[0]
        if not self.membre_id and embed_log.fields:
            user_id_str = (
                embed_log.fields[0].value.split("`")[1]
                if "`" in embed_log.fields[0].value
                else "0"
            )
            self.membre_id = int(user_id_str)
            self.type_ticket = (
                embed_log.fields[1].value.replace("`", "").lower()
            )

        membre = interaction.guild.get_member(self.membre_id)
        if membre:
            try:
                await membre.send(
                    f"❌ Ta demande de ticket `{self.type_ticket}` sur **{interaction.guild.name}** a été refusée par l'équipe."
                )
            except Exception:
                pass

        for child in self.children:
            child.disabled = True

        embed_log.color = 0xE74C3C
        embed_log.set_footer(
            text=f"❌ Ticket refusé par {interaction.user.display_name}"
        )
        await interaction.message.edit(embed=embed_log, view=self)

        await interaction.followup.send("❌ Ticket refusé.", ephemeral=True)


class TicketView(discord.ui.View):

    def __init__(self):
        super().__init__(timeout=None)
        self.add_item(MenuChoixTicket())


class FermerTicketView(discord.ui.View):

    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Fermer le ticket",
        style=discord.ButtonStyle.danger,
        emoji="🔒",
        custom_id="bouton_fermer_ticket",
    )
    async def fermer_ticket(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ):
        await interaction.response.send_message(
            "🔒 Fermeture du ticket dans 5 secondes..."
        )

        channel_id_str = str(interaction.channel.id)
        tickets_actifs = donnees.get("tickets_config", {}).get("tickets_actifs", {})
        info_ticket = tickets_actifs.get(channel_id_str, {})

        owner_id = info_ticket.get("owner_id")
        type_ticket = info_ticket.get("type", "Inconnu").upper()
        date_ouverture_iso = info_ticket.get("ouvert_a")

        membre_auteur = (
            interaction.guild.get_member(owner_id) if owner_id else None
        )
        auteur_mention = (
            f"{membre_auteur.mention} (`{owner_id}`)"
            if membre_auteur
            else (f"`{owner_id}`" if owner_id else "Inconnu")
        )

        ferme_par_mention = (
            f"{interaction.user.mention} (`{interaction.user.id}`)"
        )

        date_fermeture_str = f"<t:{int(datetime.now(timezone.utc).timestamp())}:f>"
        date_ouverture_str = "Inconnue"
        if date_ouverture_iso:
            try:
                dt_ouv = datetime.fromisoformat(date_ouverture_iso)
                date_ouverture_str = f"<t:{int(dt_ouv.timestamp())}:f>"
            except Exception:
                pass

        embed_fermeture = discord.Embed(
            title="🔒 Ticket Fermé",
            color=0xE74C3C,
        )
        embed_fermeture.add_field(
            name="👤 Auteur du ticket", value=auteur_mention, inline=True
        )
        embed_fermeture.add_field(
            name="🛠️ Fermé par", value=ferme_par_mention, inline=True
        )
        embed_fermeture.add_field(
            name="🏷️ Type", value=f"`{type_ticket}`", inline=False
        )
        embed_fermeture.add_field(
            name="🕒 Date ouverture", value=date_ouverture_str, inline=True
        )
        embed_fermeture.add_field(
            name="⌛ Date fermeture", value=date_fermeture_str, inline=True
        )
        embed_fermeture.set_footer(
            text=f"Salon : {interaction.channel.name}"
        )

        await envoyer_log_ticket(interaction.guild, embed_fermeture)

        if channel_id_str in tickets_actifs:
            del tickets_actifs[channel_id_str]
            sauvegarder()

        await asyncio.sleep(5)
        await interaction.channel.delete()


@tree.command(
    name="setup_logs_tickets",
    description="[STAFF] Définir le salon de réception des demandes de tickets",
)
@app_commands.describe(salon="Le salon textuel de logs des tickets")
async def setup_logs_tickets(
    interaction: discord.Interaction, salon: discord.TextChannel
):
    if not peut_gerer(interaction):
        await interaction.response.send_message(
            "❌ Permission insuffisante.", ephemeral=True
        )
        return

    donnees.setdefault("tickets_config", {})["channel_logs_id"] = salon.id
    sauvegarder()

    await interaction.response.send_message(
        f"✅ Salon des logs de tickets configuré sur {salon.mention}.",
        ephemeral=True,
    )


@tree.command(
    name="setup_panneau_tickets",
    description="[STAFF] Envoyer le message de création des tickets",
)
async def setup_panneau_tickets(interaction: discord.Interaction):
    if not peut_gerer(interaction):
        await interaction.response.send_message(
            "❌ Permission insuffisante.", ephemeral=True
        )
        return

    embed = discord.Embed(
        title="🎫 Support & Demandes de Ticket",
        description=(
            "Besoin d'aide, d'effectuer un signalement ou de contacter l'équipe ?\n\n"
            "Sélectionne la raison de ton ticket dans le menu déroulant ci-dessous.\n"
            "Chaque demande est transmise à l'équipe avant validation."
        ),
        color=0x3498DB,
    )
    await interaction.channel.send(embed=embed, view=TicketView())
    await interaction.response.send_message(
        "✅ Panneau de tickets envoyé dans ce salon !", ephemeral=True
    )

# ============================================================
# SYSTÈME DE SALONS PERMANENTS EN CATEGORIE DÉFINIE (/salon)
# ============================================================

groupe_salon = app_commands.Group(
    name="salon", description="Gestion des salons permanents des membres"
)


@groupe_salon.command(
    name="créer", description="Créer ton salon vocal et textuel permanent"
)
@app_commands.describe(nom="Le nom de ton salon")
async def salon_creer(interaction: discord.Interaction, nom: str):
    guild = interaction.guild
    membre = interaction.user

    categorie = guild.get_channel(ID_CATEGORIE_PERMANENTE)
    if not categorie or not isinstance(categorie, discord.CategoryChannel):
        await interaction.response.send_message(
            "❌ La catégorie configurée est introuvable. Contacte un administrateur.",
            ephemeral=True,
        )
        return

    nom_clean = nom.lower().replace(" ", "-")

    salon_existant = discord.utils.get(
        categorie.channels, name=f"💬-{nom_clean}"
    )
    if salon_existant:
        await interaction.response.send_message(
            "❌ Un salon porte déjà ce nom dans la catégorie.", ephemeral=True
        )
        return

    await interaction.response.defer(ephemeral=True)

    overwrites = {
        guild.default_role: discord.PermissionOverwrite(
            read_messages=False, connect=False
        ),
        membre: discord.PermissionOverwrite(
            read_messages=True,
            send_messages=True,
            connect=True,
            speak=True,
            manage_channels=True,
        ),
        guild.me: discord.PermissionOverwrite(
            read_messages=True,
            send_messages=True,
            connect=True,
            manage_channels=True,
        ),
    }

    salon_texte = await guild.create_text_channel(
        name=f"💬-{nom_clean}", category=categorie, overwrites=overwrites
    )
    salon_vocal = await guild.create_voice_channel(
        name=f"🔊 {nom}", category=categorie, overwrites=overwrites
    )

    embed = discord.Embed(
        title=f"🏰 Salon de {membre.display_name}",
        description=(
            f"Bienvenue dans ton espace permanent {membre.mention} !\n\n"
            "• `/salon ajouter joueur @membre` : Donner l'accès à tes salons.\n"
            "• `/salon retirer joueur @membre` : Enlever l'accès à tes salons.\n"
            "• `/salon supprimer` : Supprimer définitivement ton espace."
        ),
        color=0x3498DB,
    )
    await salon_texte.send(embed=embed)

    await interaction.followup.send(
        f"✅ Tes salons ont été créés dans **{categorie.name}** :\n"
        f"• Textuel : {salon_texte.mention}\n"
        f"• Vocal : {salon_vocal.mention}",
        ephemeral=True,
    )


@groupe_salon.command(
    name="supprimer", description="Supprimer définitivement tes salons permanents"
)
async def salon_supprimer(interaction: discord.Interaction):
    guild = interaction.guild
    membre = interaction.user

    categorie = guild.get_channel(ID_CATEGORIE_PERMANENTE)
    if not categorie or not isinstance(categorie, discord.CategoryChannel):
        await interaction.response.send_message(
            "❌ Catégorie introuvable.", ephemeral=True
        )
        return

    salons_a_supprimer = [
        chan
        for chan in categorie.channels
        if chan.permissions_for(membre).manage_channels
    ]

    if not salons_a_supprimer:
        await interaction.response.send_message(
            "❌ Tu n'as aucun salon permanent à supprimer dans cette catégorie.",
            ephemeral=True,
        )
        return

    await interaction.response.send_message(
        "🗑️ Suppression de tes salons en cours...", ephemeral=True
    )

    for chan in salons_a_supprimer:
        try:
            await chan.delete()
        except Exception as e:
            print(f"Erreur lors de la suppression de {chan.name}: {e}")


# Sous-groupe "ajouter" -> /salon ajouter joueur
groupe_ajouter = app_commands.Group(
    name="ajouter", description="Ajouter des éléments au salon"
)


@groupe_ajouter.command(
    name="joueur", description="Ajouter un joueur à ton salon permanent"
)
@app_commands.describe(joueur="Le membre à inviter dans tes salons")
async def ajouter_joueur(
    interaction: discord.Interaction, joueur: discord.Member
):
    guild = interaction.guild
    membre = interaction.user

    categorie = guild.get_channel(ID_CATEGORIE_PERMANENTE)
    if not categorie or not isinstance(categorie, discord.CategoryChannel):
        await interaction.response.send_message(
            "❌ Catégorie introuvable.", ephemeral=True
        )
        return

    salons_perso = [
        chan
        for chan in categorie.channels
        if chan.permissions_for(membre).manage_channels
    ]

    if not salons_perso:
        await interaction.response.send_message(
            "❌ Tu ne possèdes aucun salon permanent à gérer.",
            ephemeral=True,
        )
        return

    for chan in salons_perso:
        if isinstance(chan, discord.TextChannel):
            await chan.set_permissions(
                joueur, read_messages=True, send_messages=True
            )
        elif isinstance(chan, discord.VoiceChannel):
            await chan.set_permissions(
                joueur, read_messages=True, connect=True, speak=True
            )

    await interaction.response.send_message(
        f"✅ {joueur.mention} a maintenant accès à tes salons !"
    )


groupe_salon.add_command(groupe_ajouter)

# Sous-groupe "retirer" -> /salon retirer joueur
groupe_retirer = app_commands.Group(
    name="retirer", description="Retirer des éléments du salon"
)


@groupe_retirer.command(
    name="joueur", description="Retirer un joueur de tes salons permanents"
)
@app_commands.describe(joueur="Le membre à retirer de tes salons")
async def retirer_joueur(
    interaction: discord.Interaction, joueur: discord.Member
):
    guild = interaction.guild
    membre = interaction.user

    categorie = guild.get_channel(ID_CATEGORIE_PERMANENTE)
    if not categorie or not isinstance(categorie, discord.CategoryChannel):
        await interaction.response.send_message(
            "❌ Catégorie introuvable.", ephemeral=True
        )
        return

    salons_perso = [
        chan
        for chan in categorie.channels
        if chan.permissions_for(membre).manage_channels
    ]

    if not salons_perso:
        await interaction.response.send_message(
            "❌ Tu ne possèdes aucun salon permanent à gérer.",
            ephemeral=True,
        )
        return

    for chan in salons_perso:
        await chan.set_permissions(joueur, overwrite=None)
        if (
            isinstance(chan, discord.VoiceChannel)
            and joueur.voice
            and joueur.voice.channel == chan
        ):
            await joueur.move_to(None)

    await interaction.response.send_message(
        f"🚫 {joueur.mention} n'a plus accès à tes salons."
    )


groupe_salon.add_command(groupe_retirer)

tree.add_command(groupe_salon)

# ============================================================
# ÉVÉNEMENT HISTOIRE INFINIE & ON_READY
# ============================================================
@bot.event
async def on_message(message):
    if message.author.bot:
        return

    # Jeu d'Histoire Infinie
    if message.channel.id == 1541006278191747182:
        jeu = donnees.setdefault(
            "jeu_histoire", {"mots": [], "dernier_joueur_id": None}
        )

        # 1. Vérification : deux messages de suite par la même personne
        if jeu.get("dernier_joueur_id") == message.author.id:
            try:
                await message.delete()
            except Exception:
                pass

            msg_err = await message.channel.send(
                f"❌ {message.author.mention}, tu ne peux pas jouer deux fois d'affilée !"
            )
            await asyncio.sleep(4)
            try:
                await msg_err.delete()
            except Exception:
                pass
            return

        # 2. Vérification de la limite de mots
        mots_msg = message.content.strip().split()

        if len(mots_msg) > LIMITE_MOTS:
            try:
                await message.delete()
            except Exception:
                pass

            msg_err = await message.channel.send(
                f"❌ {message.author.mention}, ton message dépasse la limite de {LIMITE_MOTS} mot(s) !"
            )
            await asyncio.sleep(4)
            try:
                await msg_err.delete()
            except Exception:
                pass
            return

        # 3. Validation et enregistrement
        jeu["mots"].extend(mots_msg)
        jeu["dernier_joueur_id"] = message.author.id
        sauvegarder()

        # Ajout de la réaction ✅ sur le message valide
        try:
            await message.add_reaction("✅")
        except Exception:
            pass

    # Traitement des autres commandes
    await bot.process_commands(message)


@bot.event
async def on_ready():
    print(f"✅ Bot connecté sous l'identité : {bot.user}")

    # Enregistrement des vues persistantes (Tickets)
    bot.add_view(TicketView())
    bot.add_view(FermerTicketView())
    bot.add_view(ValiderTicketView())

    # Lancement du loop Dashboard s'il est configuré
    if not update_tableau_de_board.is_running():
        update_tableau_de_board.start()

    # Synchronisation des commandes slash avec Discord
    try:
        synced = await tree.sync()
        print(f"⚡ {len(synced)} commande(s) slash synchronisée(s).")
    except Exception as e:
        print(f"❌ Erreur lors de la synchronisation des commandes : {e}")
        
# ============================================================
# LANCEMENT DU BOT
# ============================================================
import os
from dotenv import load_dotenv

# Charge le fichier .env s'il existe (pour ton PC en local)
load_dotenv()

# Récupère le token depuis l'environnement (local ou hébergeur)
TOKEN = os.getenv("DISCORD_TOKEN")

if not TOKEN:
    print("❌ Erreur : DISCORD_TOKEN introuvable !")
    exit()

bot.run(TOKEN)
