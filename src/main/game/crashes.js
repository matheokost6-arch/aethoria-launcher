'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { shell } = require('electron');
const paths = require('./paths');

/** Rapports de plantage ecrits par Minecraft dans crash-reports/. */

const folder = () => path.join(paths.root, 'crash-reports');
const REPORT_NAME = /^crash-[\w.-]+\.txt$/;

function reportPath(name) {
  if (path.basename(String(name)) !== name || !REPORT_NAME.test(name)) throw new Error('Rapport introuvable.');
  return path.join(folder(), name);
}

/** Debut du rapport : la description et l'erreur y figurent toujours. */
async function readHead(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(8192), 0, 8192, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function list(limit = 10) {
  const names = (await fsp.readdir(folder()).catch(() => [])).filter((name) => REPORT_NAME.test(name));
  const reports = await Promise.all(names.map(async (name) => {
    const file = path.join(folder(), name);
    const [stat, head] = await Promise.all([fsp.stat(file), readHead(file)]);
    return {
      name,
      date: stat.mtimeMs,
      description: head.match(/^Description:\s*(.+)$/m)?.[1]?.trim() || 'Plantage',
      cause: head.match(/^([\w.$]+(?:Exception|Error)\b[^\r\n]*)/m)?.[1]?.slice(0, 200) || null,
    };
  }));
  return reports.sort((a, b) => b.date - a.date).slice(0, limit);
}

function open(name) {
  return shell.openPath(reportPath(name));
}

async function read(name) {
  return (await fsp.readFile(reportPath(name), 'utf8')).slice(0, 20000);
}

module.exports = { list, open, read };
