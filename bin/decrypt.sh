#!/bin/bash

keyid=$1
key=$2
srcpath=$3
outpath=$4
rootpath=$5
streamtype=$6

$rootpath/bin/packager-linux-x64 in=$srcpath,stream=$streamtype,output=$outpath,drm_label=HD --enable_raw_key_decryption --keys label=HD:key_id=$keyid:key=$key --quiet
