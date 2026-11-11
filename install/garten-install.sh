#!/usr/bin/env bash
# Copyright (c) Kogoro | License: MIT | Source: https://github.com/Kogoro/Garten
# Runs inside the new container (called by ct/garten.sh through the community-scripts engine).

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

msg_info "Installing Garten (this takes a few minutes)"
export GARTEN_URL=auto
$STD bash -c "$(curl -fsSL "${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/Kogoro/Garten/main}/scripts/install-debian.sh")"
msg_ok "Installed Garten"

motd_ssh
customize
cleanup_lxc
