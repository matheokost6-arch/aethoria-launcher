'use strict';

/**
 * Exemple d'integration dans un bot discord.js existant.
 *
 * Rien ici n'est a copier tel quel : prends les morceaux qui t'interessent et
 * greffe-les sur ton bot. Deux facons de publier sont montrees, tu peux
 * garder les deux ou n'en garder qu'une :
 *
 *   1. la commande /annonce, avec un titre et un texte ;
 *   2. la surveillance d'un salon : tout message y devient une actualite.
 *
 * La seconde est la plus pratique au quotidien — tu ecris ton annonce dans
 * #annonces comme d'habitude, et elle apparait dans le launcher.
 */

const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const actualites = require('./actualites');

// Salon surveille. Laisse vide pour n'utiliser que la commande /annonce.
const SALON_ANNONCES = process.env.SALON_ANNONCES || '';

/* ------------------------------------------------------------------ *
 *  1. Commande /annonce
 * ------------------------------------------------------------------ */

const commandeAnnonce = new SlashCommandBuilder()
  .setName('annonce')
  .setDescription('Publie une actualite dans le launcher Aethoria')
  .addStringOption((o) => o
    .setName('titre')
    .setDescription('Titre affiche en gras')
    .setRequired(true)
    .setMaxLength(80))
  .addStringOption((o) => o
    .setName('texte')
    .setDescription('Le contenu de l’annonce')
    .setRequired(true))
  // Seuls ceux qui peuvent deja gerer le serveur publient dans le launcher.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

const commandeRetirer = new SlashCommandBuilder()
  .setName('annonce-retirer')
  .setDescription('Retire la derniere actualite publiee')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

const commandeListe = new SlashCommandBuilder()
  .setName('annonces')
  .setDescription('Affiche les actualites visibles dans le launcher')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function gererCommande(interaction) {
  if (!interaction.isChatInputCommand()) return;

  // L'ecriture sur GitHub prend une a deux secondes : au-dela de trois,
  // Discord considere la commande comme sans reponse.
  await interaction.deferReply({ ephemeral: true });

  try {
    if (interaction.commandName === 'annonce') {
      const resultat = await actualites.publier(
        interaction.options.getString('titre'),
        interaction.options.getString('texte'),
      );
      await interaction.editReply(
        `Actualite publiee : **${resultat.title}**\n`
        + `Elle apparaitra dans le launcher au prochain demarrage des joueurs.\n`
        + `${resultat.total} actualite(s) affichee(s).`,
      );
      return;
    }

    if (interaction.commandName === 'annonce-retirer') {
      const retiree = await actualites.retirerDerniere();
      await interaction.editReply(`Actualite retiree : **${retiree.title}**`);
      return;
    }

    if (interaction.commandName === 'annonces') {
      const liste = await actualites.lister();
      if (!liste.length) {
        await interaction.editReply('Aucune actualite pour le moment.');
        return;
      }
      await interaction.editReply(
        liste.map((a, i) => `**${i + 1}. ${a.title}** — ${a.date}`).join('\n'),
      );
    }
  } catch (err) {
    // On repond toujours quelque chose : sans cela, la commande reste
    // affichee comme "en cours" indefiniment.
    await interaction.editReply(`Echec : ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 *  2. Surveillance d'un salon
 * ------------------------------------------------------------------ */

async function gererMessage(message) {
  if (!SALON_ANNONCES || message.channelId !== SALON_ANNONCES) return;
  if (message.author.bot) return;

  try {
    const resultat = await actualites.publierDepuisMessage(message);
    // Une reaction suffit a confirmer, sans encombrer le salon d'annonces.
    await message.react('📜');
    console.log(`Actualite publiee : ${resultat.title}`);
  } catch (err) {
    await message.react('⚠️').catch(() => {});
    console.error(`Publication impossible : ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 *  Branchement
 * ------------------------------------------------------------------ */

function brancher(client) {
  client.on('interactionCreate', gererCommande);
  if (SALON_ANNONCES) client.on('messageCreate', gererMessage);
}

/** Enregistre les commandes aupres de Discord. A lancer une seule fois. */
async function enregistrerCommandes(client, guildId) {
  const commandes = [commandeAnnonce, commandeRetirer, commandeListe].map((c) => c.toJSON());
  // Sur un serveur precis, les commandes sont disponibles immediatement ;
  // en global, Discord met jusqu'a une heure a les propager.
  const cible = guildId ? client.guilds.cache.get(guildId) : client.application;
  await cible.commands.set(commandes);
  console.log(`${commandes.length} commandes enregistrees.`);
}

module.exports = { brancher, enregistrerCommandes, gererCommande, gererMessage };

/* ------------------------------------------------------------------ *
 *  Bot autonome, si tu preferes en lancer un a part
 * ------------------------------------------------------------------ */

if (require.main === module) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // Necessaires uniquement pour la surveillance de salon. "MessageContent"
      // est un intent privilegie : active-le dans le portail developpeur
      // Discord, onglet Bot, sinon les messages arrivent vides.
      ...(SALON_ANNONCES ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] : []),
    ],
  });

  client.once('clientReady', async () => {
    console.log(`Connecte en tant que ${client.user.tag}`);
    await enregistrerCommandes(client, process.env.DISCORD_GUILD_ID);
    if (SALON_ANNONCES) console.log(`Salon surveille : ${SALON_ANNONCES}`);
  });

  brancher(client);
  client.login(process.env.DISCORD_BOT_TOKEN);
}
