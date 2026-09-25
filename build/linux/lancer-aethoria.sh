#!/bin/sh
# Lance Aethoria depuis une archive decompressee.
#
# Chromium, sur lequel repose le launcher, isole son interface dans un "bac a
# sable" qui reclame un fichier avec des droits speciaux (chrome-sandbox en
# setuid root). Une archive .tar.gz ne peut pas les transporter, et les
# distributions recentes (Ubuntu 24.04 et suivantes) refusent la solution de
# repli : le launcher se fermerait aussitot. On detecte le cas et on demarre
# alors sans bac a sable.
#
# Les paquets .deb et .rpm, eux, posent ces droits a l'installation : ils sont
# a preferer quand la distribution les accepte.

DOSSIER=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -u "$DOSSIER/chrome-sandbox" ]; then
  exec "$DOSSIER/aethoria" "$@"
fi

exec "$DOSSIER/aethoria" --no-sandbox "$@"
