#!/bin/bash

OUTNAME=$1
DIRPATH=$2
INITNAME=$DIRPATH"init.mp4"

rm -f $OUTNAME
cat $INITNAME >> $OUTNAME

if [ -e $OUTNAME ]; then
  rm -f $OUTNAME
fi

for file in $DIRPATH*; do
    if [[ -f "$file" && "$file" != $INITNAME ]]; then
	cat $file >> $OUTNAME
    fi
done
