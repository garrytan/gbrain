#!/bin/bash
cd /var/tmp/rx
if [ "$1" = pg ]; then
  psql -h 127.0.0.1 -p 5499 -U postgres -qc 'drop database brain' -c 'create database brain template brain_snap'
else
  rm -rf h-pgl && cp -a h-pgl-snap h-pgl
fi
