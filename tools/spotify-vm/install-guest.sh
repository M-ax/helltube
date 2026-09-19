#!/usr/bin/env bash
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  xfce4 lightdm xserver-xorg dbus-x11 x11-xserver-utils \
  pulseaudio pulseaudio-utils playerctl ffmpeg python3 xdg-utils \
  fonts-dejavu-core xterm wmctrl libnotify-bin desktop-file-utils
install -d -m 755 /etc/apt/keyrings
curl -fsSL https://download.spotify.com/debian/pubkey_5384CE82BA52C83A.asc \
  -o /etc/apt/keyrings/spotify.asc
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
  -o /etc/apt/keyrings/google-chrome.asc
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/spotify.asc] https://repository.spotify.com stable non-free' \
  > /etc/apt/sources.list.d/spotify.list
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main' \
  > /etc/apt/sources.list.d/google-chrome.list
apt-get update
apt-get install -y --no-install-recommends spotify-client google-chrome-stable

install -d /etc/lightdm/lightdm.conf.d
cat > /etc/lightdm/lightdm.conf.d/50-spotify.conf <<'EOF'
[Seat:*]
autologin-user=spotify
autologin-user-timeout=0
user-session=xfce
xserver-command=X -s 0 -dpms
EOF
install -d -o spotify -g spotify /home/spotify/.config/autostart /home/spotify/.config/pulse /home/spotify/Desktop
cat > /usr/local/bin/helltube-spotify-session <<'EOF'
#!/bin/sh
xrandr --output Virtual-1 --mode 1920x1080
xset s off
xset -dpms
xdg-settings set default-web-browser google-chrome.desktop
EOF
cat > /usr/local/bin/helltube-spotify-sharing <<'EOF'
#!/bin/sh
set -eu
case "${1:-}" in
  on)
    mkdir -p "$HOME/.config/helltube"
    touch "$HOME/.config/helltube/sharing-enabled"
    notify-send Helltube 'Spotify desktop sharing enabled'
    ;;
  off)
    rm -f "$HOME/.config/helltube/sharing-enabled"
    notify-send Helltube 'Spotify desktop sharing disabled'
    ;;
  *) exit 2 ;;
esac
EOF
chmod 755 /usr/local/bin/helltube-spotify-session /usr/local/bin/helltube-spotify-sharing
cat > /home/spotify/.config/pulse/default.pa <<'EOF'
.include /etc/pulse/default.pa
load-module module-null-sink sink_name=helltube rate=48000 channels=2 sink_properties=device.description=Helltube
set-default-sink helltube
set-default-source helltube.monitor
EOF
cat > /home/spotify/.config/autostart/spotify.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Spotify
Exec=spotify --ozone-platform=x11
Terminal=false
EOF
cat > /home/spotify/.config/autostart/desktop-settings.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Helltube desktop settings
Exec=/usr/local/bin/helltube-spotify-session
Terminal=false
EOF
cat > /home/spotify/Desktop/enable-sharing.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Enable Helltube sharing
Comment=Sign into Spotify first. The desktop can then be broadcast to a Helltube room.
Exec=/usr/local/bin/helltube-spotify-sharing on
Icon=media-playback-start
Terminal=false
EOF
cat > /home/spotify/Desktop/disable-sharing.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Disable Helltube sharing
Comment=Stop broadcasting before signing in or changing private account settings.
Exec=/usr/local/bin/helltube-spotify-sharing off
Icon=media-playback-stop
Terminal=false
EOF
chown -R spotify:spotify /home/spotify/.config /home/spotify/Desktop
chmod 755 /home/spotify/Desktop/*.desktop
desktop-file-validate /home/spotify/Desktop/*.desktop /home/spotify/.config/autostart/*.desktop
systemctl set-default graphical.target
systemctl enable --now lightdm
touch /var/lib/helltube-desktop-installed
