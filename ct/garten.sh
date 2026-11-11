#!/usr/bin/env bash
# Garten (Specs) – Proxmox VE LXC container, built on the community-scripts engine.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kogoro/Garten/main/ct/garten.sh)"
#
# Run on the Proxmox host. Container settings can be changed in the "Advanced" menu or with var_cpu=… var_ram=… var_disk=…
# The install script is install/garten-install.sh in this repository (COMMUNITY_SCRIPTS_URL points here by default).
export COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/Kogoro/Garten/main}"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
# Copyright (c) Kogoro | License: MIT | Source: https://github.com/Kogoro/Garten

APP="Garten"
var_tags="${var_tags:-specs;ai;documentation}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-6}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_arm64="${var_arm64:-yes}"
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources
  if [[ ! -d /opt/garten ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi
  msg_info "Updating ${APP} (data is kept)"
  bash /opt/garten/scripts/install-debian.sh
  msg_ok "Updated ${APP}"
  exit
}

start
build_container
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Open it with a browser (VPN on):${CL}"
echo -e "${GATEWAY}${BGN}https://${IP}${CL}"
echo -e "${INFO}${YW}First, once per phone: install the certificate from${CL} ${BGN}http://${IP}/${CL}"
echo -e "${INFO}${YW}Admin login: inside the container, 'cat /root/garten.creds' (Proxmox: pct exec <id> cat /root/garten.creds)${CL}"
