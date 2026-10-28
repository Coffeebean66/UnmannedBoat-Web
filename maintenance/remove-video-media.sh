#!/usr/bin/env bash
# 停用独立视频网关，保留程序、私密配置和账号，方便再次运行安装脚本恢复。
set -euo pipefail
umask 077
die() { echo "Video media removal: $*" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || die 'run with sudo.'
check_only=0
if [[ $# -eq 1 && "$1" == --check-only ]]; then check_only=1
elif [[ $# -ne 0 ]]; then die 'usage: sudo bash maintenance/remove-video-media.sh [--check-only]'; fi
for name in systemctl stat dirname grep cat mktemp cp install rm; do
  command -v "$name" >/dev/null || die "missing prerequisite: $name"
done
config=/etc/unmanned-boat-video
program=/usr/local/lib/unmanned-boat-video
units=/etc/systemd/system
unit="$units/unmanned-boat-video.service"
dropin="$units/unmanned-boat-web.service.d/45-video-media.conf"
marker=unmanned-boat-video-media-v1
trusted_path() {
  local current="$1" permissions
  while [[ "$current" != / ]]; do
    [[ ! -L "$current" ]] || die 'linked installation paths are not supported.'
    if [[ -e "$current" ]]; then
      permissions="$(stat -c %a "$current")"
      [[ "$permissions" =~ ^[0-7]{3,4}$ && "$(stat -c %u "$current")" == 0 ]] &&
        (( (8#$permissions & 8#022) == 0 )) || die 'installation paths must be root-owned and not group/world-writable.'
    fi
    current="$(dirname -- "$current")"
  done
}
for directory in "$program" "$config"; do
  trusted_path "$directory"
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" && -f "$directory/.boat-video-media-deployment" && ! -L "$directory/.boat-video-media-deployment" && "$(cat "$directory/.boat-video-media-deployment")" == "$marker" ]] || die 'refusing an unrelated video installation directory.'
    trusted_path "$directory/.boat-video-media-deployment"
  fi
done
for entry in "$unit" "$dropin"; do
  trusted_path "$entry"
  if [[ -e "$entry" ]]; then
    [[ -f "$entry" && "$(stat -c %h "$entry")" == 1 ]] && grep -qx '# Owned by unmanned-boat-video-media-v1' "$entry" || die 'refusing an unrelated service or web drop-in.'
  fi
done
if [[ -e "$dropin" ]]; then
  trusted_path "$units/unmanned-boat-web.service"
  [[ -f "$units/unmanned-boat-web.service" ]] && grep -qx '# Owned by unmanned-boat-web-v1' "$units/unmanned-boat-web.service" || die 'refusing to change an unmanaged web service.'
fi
if [[ "$check_only" == 1 ]]; then echo 'Video media ownership checks passed; no services or files were changed.'; exit 0; fi
if [[ ! -e "$unit" && ! -e "$dropin" ]]; then echo 'No managed video service is installed; existing configurations were kept.'; exit 0; fi

video_was_active=0
video_was_enabled=0
web_was_active=0
systemctl is-active --quiet unmanned-boat-video.service && video_was_active=1
systemctl is-enabled --quiet unmanned-boat-video.service && video_was_enabled=1
systemctl is-active --quiet unmanned-boat-web.service && web_was_active=1
stage="$(mktemp -d /tmp/boat-video-media-remove.XXXXXXXX)"
completed=0
committing=0
dropin_existed=0
finish() {
  local status=$?
  trap - EXIT
  if [[ "$committing" == 1 && "$completed" == 0 ]]; then
    set +e
    [[ "$dropin_existed" == 0 ]] || install -o root -g root -m 644 "$stage/web-dropin" "$dropin"
    systemctl daemon-reload
    [[ "$web_was_active" == 0 ]] || systemctl restart unmanned-boat-web.service
    [[ "$video_was_enabled" == 0 ]] || systemctl enable unmanned-boat-video.service
    [[ "$video_was_active" == 0 ]] || systemctl start unmanned-boat-video.service
    echo 'Video media removal did not complete; previous service settings were restored.' >&2
  fi
  if [[ "$stage" == /tmp/boat-video-media-remove.* && -d "$stage" && ! -L "$stage" ]]; then rm -rf -- "$stage"; fi
  exit "$status"
}
trap finish EXIT
if [[ -f "$dropin" ]]; then cp -- "$dropin" "$stage/web-dropin"; dropin_existed=1; fi
committing=1
if [[ -f "$unit" ]]; then systemctl disable --now unmanned-boat-video.service; fi
rm -f -- "$dropin"
systemctl daemon-reload
if [[ "$web_was_active" == 1 && "$dropin_existed" == 1 ]]; then
  systemctl restart unmanned-boat-web.service
  systemctl is-active --quiet unmanned-boat-web.service || die 'web service failed to restart; removal will roll back.'
fi
completed=1
echo 'SRT/WebRTC video gateway disabled; the website keeps its MQTT telemetry and HTTP/HLS/FLV players.'
echo 'Program, service unit and private configuration remain for recovery in /usr/local/lib/unmanned-boat-video and /etc/unmanned-boat-video.'
echo 'Existing recordings under /var/lib/unmanned-boat-video and web recording settings are retained; this script does not delete video files.'
echo 'Re-run maintenance/install-video-media.sh with the public host to restore this gateway. MQTT/video account settings were not changed.'
