"""
Publication des actualités du launcher Aethoria depuis le bot Discord.

Le manifest du launcher vit dans le dépôt public GitHub, et le launcher le
relit à chaque démarrage. Publier une annonce revient donc à modifier sa
section « news » — ce que fait ce module via l'API GitHub, sans clone ni
dépôt local.

Aucune dépendance nouvelle : aiohttp est déjà utilisé par le bot.

Configuration (variables d'environnement, comme DISCORD_TOKEN) :
    GITHUB_TOKEN   jeton ayant le droit d'écrire dans le dépôt public
    GITHUB_OWNER   défaut : matheokost6-arch
    GITHUB_REPO    défaut : aethoria
    SALON_ANNONCES optionnel : identifiant du salon à surveiller

Le jeton reste chez le bot ; il n'est jamais livré dans le launcher.

Branchement dans bot.py, trois lignes :

    import actualites
    actualites.enregistrer_commandes(tree)      # après la création de "tree"
    # et, dans on_message si tu surveilles un salon :
    await actualites.traiter_message(message)
"""

import base64
import json
import os
from datetime import datetime

import aiohttp
import discord
from discord import app_commands

API = "https://api.github.com"

OWNER = os.getenv("GITHUB_OWNER", "matheokost6-arch")
REPO = os.getenv("GITHUB_REPO", "aethoria")
CHEMIN = "manifest.json"
SALON_ANNONCES = os.getenv("SALON_ANNONCES", "")

# Au-delà, le panneau du launcher devient une liste que plus personne ne lit.
# Les annonces récentes chassent les anciennes.
MAX_ACTUALITES = 6

MOIS = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
]


class ErreurActualite(Exception):
    """Erreur destinée à être montrée telle quelle à celui qui publie."""


# --------------------------------------------------------------------- #
#  Accès au manifest
# --------------------------------------------------------------------- #

def _entetes() -> dict:
    jeton = os.getenv("GITHUB_TOKEN")
    if not jeton:
        raise ErreurActualite(
            "GITHUB_TOKEN absent : le bot ne peut pas écrire dans le dépôt."
        )
    return {
        "Authorization": f"Bearer {jeton}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "AethoriaBot",
    }


async def _lire_manifest(session: aiohttp.ClientSession):
    """
    Récupère le manifest et l'empreinte de sa version actuelle.

    Cette empreinte est indispensable pour écrire : GitHub refuse la
    modification si le fichier a changé entre-temps, ce qui évite qu'une
    publication simultanée en écrase une autre.
    """
    url = f"{API}/repos/{OWNER}/{REPO}/contents/{CHEMIN}"
    async with session.get(url, headers=_entetes()) as reponse:
        if reponse.status in (401, 403):
            raise ErreurActualite(
                "Jeton GitHub refusé. Vérifie GITHUB_TOKEN et ses permissions."
            )
        if reponse.status == 404:
            raise ErreurActualite(f"manifest.json introuvable dans {OWNER}/{REPO}.")
        if reponse.status != 200:
            raise ErreurActualite(f"GitHub a répondu HTTP {reponse.status}.")

        donnees = await reponse.json()

    contenu = base64.b64decode(donnees["content"]).decode("utf-8")
    return json.loads(contenu), donnees["sha"]


async def _ecrire_manifest(session, manifest: dict, sha: str, message: str) -> None:
    url = f"{API}/repos/{OWNER}/{REPO}/contents/{CHEMIN}"
    corps = {
        "message": message,
        "content": base64.b64encode(
            (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        ).decode("ascii"),
        "sha": sha,
    }

    async with session.put(url, headers=_entetes(), json=corps) as reponse:
        if reponse.status == 409:
            raise ErreurActualite(
                "Le manifest a changé entre-temps. Relance la commande."
            )
        if reponse.status not in (200, 201):
            detail = await reponse.json()
            raise ErreurActualite(
                detail.get("message", f"GitHub a répondu HTTP {reponse.status}.")
            )


# --------------------------------------------------------------------- #
#  Mise en forme
# --------------------------------------------------------------------- #

def _date_en_clair(quand: datetime | None = None) -> str:
    quand = quand or datetime.now()
    return f"{quand.day} {MOIS[quand.month - 1]} {quand.year}"


def nettoyer(texte: str) -> str:
    """
    Nettoie un texte écrit sur Discord.

    Le panneau du launcher n'affiche que du texte : mentions, emojis
    personnalisés et liens Markdown y apparaîtraient sous leur forme brute
    (``<@123456789>``, ``<:epee:987654>``), ce qui serait illisible.
    """
    import re

    resultat = str(texte or "")
    remplacements = [
        (r"<#\d+>", ""),                              # mentions de salon
        (r"<@[&!]?\d+>", ""),                         # mentions de membre ou de rôle
        (r"<a?:(\w+):\d+>", r"\1"),                   # emojis personnalisés
        (r"\[([^\]]+)\]\(https?://[^)]+\)", r"\1"),   # liens Markdown
        (r"\*\*\*(.+?)\*\*\*", r"\1"),
        (r"\*\*(.+?)\*\*", r"\1"),
        (r"__(.+?)__", r"\1"),
        (r"\*(.+?)\*", r"\1"),
        (r"~~(.+?)~~", r"\1"),
        (r"`{1,3}([^`]+)`{1,3}", r"\1"),
        (r"(?m)^>\s?", ""),                           # citations
        (r"(?m)^#{1,3}\s?", ""),                      # titres Markdown
        (r"\n{3,}", "\n\n"),
    ]
    for motif, remplacement in remplacements:
        resultat = re.sub(motif, remplacement, resultat)
    return resultat.strip()


def decouper(contenu: str):
    """
    Sépare titre et corps quand l'annonce arrive d'un seul bloc.

    La première ligne devient le titre si elle est courte : c'est ainsi que
    sont écrites la plupart des annonces, et cela évite d'imposer un format.
    """
    lignes = [l for l in nettoyer(contenu).split("\n") if l.strip()]
    if not lignes:
        return None

    premiere = lignes[0].strip()
    if len(lignes) > 1 and len(premiere) <= 80:
        return premiere, " ".join(lignes[1:]).strip()

    texte = " ".join(lignes)
    if len(texte) <= 80:
        # Annonce d'une ligne : pas de corps, sinon le launcher afficherait
        # deux fois la même phrase.
        return texte, ""

    coupe = texte[:77]
    espace = coupe.rfind(" ")
    return coupe[: espace if espace > 40 else 77] + "...", texte


# --------------------------------------------------------------------- #
#  Opérations publiques
# --------------------------------------------------------------------- #

async def publier(titre: str, corps: str) -> dict:
    """Publie une actualité. Renvoie l'actualité créée et le total affiché."""
    titre_propre = nettoyer(titre)
    corps_propre = nettoyer(corps)

    if not titre_propre and not corps_propre:
        raise ErreurActualite("Annonce vide.")

    # Un seul champ rempli suffit : on en déduit l'autre plutôt que de refuser.
    if not titre_propre:
        titre_propre, corps_propre = decouper(corps_propre)

    actualite = {
        "title": titre_propre,
        "body": corps_propre,
        "date": _date_en_clair(),
    }

    async with aiohttp.ClientSession() as session:
        manifest, sha = await _lire_manifest(session)
        manifest["news"] = ([actualite] + manifest.get("news", []))[:MAX_ACTUALITES]
        await _ecrire_manifest(
            session, manifest, sha, f"Actualité : {titre_propre[:60]}"
        )
        total = len(manifest["news"])

    return {**actualite, "total": total}


async def retirer_derniere() -> dict:
    """Retire l'actualité la plus récente, en cas de fausse manœuvre."""
    async with aiohttp.ClientSession() as session:
        manifest, sha = await _lire_manifest(session)
        news = manifest.get("news", [])
        if not news:
            raise ErreurActualite("Aucune actualité à retirer.")
        retiree = news.pop(0)
        manifest["news"] = news
        await _ecrire_manifest(
            session, manifest, sha, f"Actualité retirée : {retiree['title'][:60]}"
        )
    return retiree


async def lister() -> list:
    """Les actualités actuellement visibles dans le launcher."""
    async with aiohttp.ClientSession() as session:
        manifest, _ = await _lire_manifest(session)
    return manifest.get("news", [])


# --------------------------------------------------------------------- #
#  Surveillance d'un salon
# --------------------------------------------------------------------- #

async def traiter_message(message: discord.Message) -> None:
    """
    À appeler depuis on_message : tout message posté dans le salon surveillé
    devient une actualité. Ne fait rien si SALON_ANNONCES n'est pas défini.
    """
    if not SALON_ANNONCES or str(message.channel.id) != str(SALON_ANNONCES):
        return
    if message.author.bot or not message.content.strip():
        return

    try:
        decoupe = decouper(message.content)
        if not decoupe:
            return
        await publier(decoupe[0], decoupe[1])
        # Une réaction suffit à confirmer, sans encombrer le salon.
        await message.add_reaction("📜")
    except ErreurActualite as err:
        await message.add_reaction("⚠️")
        print(f"[actualites] publication impossible : {err}")
    except Exception as err:  # noqa: BLE001 - le bot ne doit pas tomber pour ça
        await message.add_reaction("⚠️")
        print(f"[actualites] erreur inattendue : {err}")


# --------------------------------------------------------------------- #
#  Commandes
# --------------------------------------------------------------------- #

def enregistrer_commandes(tree: app_commands.CommandTree) -> None:
    """Ajoute /annonce, /annonce-retirer et /annonces à l'arbre de commandes."""

    @tree.command(
        name="annonce",
        description="Publie une actualité dans le launcher Aethoria",
    )
    @app_commands.describe(
        titre="Titre affiché en gras dans le launcher",
        texte="Le contenu de l'annonce",
    )
    @app_commands.checks.has_permissions(manage_guild=True)
    async def cmd_annonce(interaction: discord.Interaction, titre: str, texte: str):
        # L'écriture sur GitHub prend une à deux secondes ; au-delà de trois,
        # Discord considère la commande comme sans réponse.
        await interaction.response.defer(ephemeral=True)
        try:
            resultat = await publier(titre, texte)
            await interaction.followup.send(
                f"Actualité publiée : **{resultat['title']}**\n"
                f"Les joueurs la verront au prochain démarrage du launcher.\n"
                f"{resultat['total']} actualité(s) affichée(s).",
                ephemeral=True,
            )
        except ErreurActualite as err:
            await interaction.followup.send(f"Échec : {err}", ephemeral=True)

    @tree.command(
        name="annonce-retirer",
        description="Retire la dernière actualité publiée",
    )
    @app_commands.checks.has_permissions(manage_guild=True)
    async def cmd_retirer(interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            retiree = await retirer_derniere()
            await interaction.followup.send(
                f"Actualité retirée : **{retiree['title']}**", ephemeral=True
            )
        except ErreurActualite as err:
            await interaction.followup.send(f"Échec : {err}", ephemeral=True)

    @tree.command(
        name="annonces",
        description="Affiche les actualités visibles dans le launcher",
    )
    @app_commands.checks.has_permissions(manage_guild=True)
    async def cmd_lister(interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            liste = await lister()
            if not liste:
                await interaction.followup.send(
                    "Aucune actualité pour le moment.", ephemeral=True
                )
                return
            lignes = [
                f"**{i + 1}. {a['title']}** — {a.get('date', '')}"
                for i, a in enumerate(liste)
            ]
            await interaction.followup.send("\n".join(lignes), ephemeral=True)
        except ErreurActualite as err:
            await interaction.followup.send(f"Échec : {err}", ephemeral=True)
