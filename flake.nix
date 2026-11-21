{
  description = "Loom dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # nixpkgs only carries Wails v2, so the v3 CLI is built here. Keep the
        # version in lockstep with github.com/wailsapp/wails/v3 in go.mod: the
        # CLI generates and consumes code that the library must agree with.
        wails3 = pkgs.buildGoModule rec {
          pname = "wails3";
          version = "3.1.0";

          src = pkgs.fetchFromGitHub {
            owner = "wailsapp";
            repo = "wails";
            rev = "v${version}";
            hash = "sha256-Eqi2QEOdgjeJXYRtFJSYgqovDXn8PFoF5QExwhFg/+8=";
          };

          # The v3 module lives in a subdirectory of the repo.
          sourceRoot = "${src.name}/v3";
          subPackages = [ "cmd/wails3" ];
          vendorHash = "sha256-VmWjstXfAcbNf/3XpP6pUPbq5K3EApSCANFVzKsruVE=";

          nativeBuildInputs = [ pkgs.pkg-config ];
          buildInputs = [ pkgs.gtk4 pkgs.webkitgtk_6_0 ];

          # The CLI embeds templates and task files; tests want a display.
          doCheck = false;
        };
        commonHook = ''
          export GOBIN="$PWD/.bin"
          export PATH="$GOBIN:$PATH"

          export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules''${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"

          # The minimal Nix environment has no /etc/fonts/fonts.conf. Without
          # an explicit config WebKitGTK can map a white window even though
          # the frontend server is healthy.
          export FONTCONFIG_FILE="''${FONTCONFIG_FILE:-${pkgs.makeFontsConf {
            fontDirectories = with pkgs; [ dejavu_fonts liberation_ttf ];
          }}}"

          # GTK's file dialog reads GSettings, and GIO treats "no schemas
          # installed" as a g_error — i.e. abort(), taking the whole app down
          # the moment the picker opens. glib's setup hook collects the schema
          # dirs into GSETTINGS_SCHEMAS_PATH but nothing puts them on the path
          # GIO actually searches, so do that here.
          export XDG_DATA_DIRS="$GSETTINGS_SCHEMAS_PATH''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"

          # WebKitGTK 2.54.2 can bind an explicit Unix PulseAudio socket into
          # its sandbox. WSLg's default PulseAudio symlink points outside it.
          if [ -S /mnt/wslg/PulseServer ]; then
            export PULSE_SERVER="''${PULSE_SERVER-unix:/mnt/wslg/PulseServer}"
          fi

          # WSLg may expose a DRM render node backed by a host driver that is
          # not usable by the NixOS WebKitGTK closure. Treat WSL as a
          # software-rendered environment even when that node exists; without
          # this WebKit can create a blank window after the app connects to
          # the Vite dev server.
          if [ -n "''${WSL_DISTRO_NAME:-}" ] || [ -n "''${WSL_INTEROP:-}" ] || [ ! -e /dev/dri/renderD128 ]; then
            # Use this shell's Mesa rather than whatever the host exposes. The
            # host ICD set can be a single unusable driver (powervr on WSL),
            # which is what makes zink fail with "failed to choose pdev" and
            # EGL fall over with "failed to get driver name for fd -1".
            export LIBGL_DRIVERS_PATH="${pkgs.mesa}/lib/dri"
            export __EGL_VENDOR_LIBRARY_DIRS="''${__EGL_VENDOR_LIBRARY_DIRS:-${pkgs.mesa}/share/glvnd/egl_vendor.d}"
            export __EGL_VENDOR_LIBRARY_FILENAMES="${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json"

            # Lavapipe, the software Vulkan ICD. VK_DRIVER_FILES is the current
            # name, VK_ICD_FILENAMES the one older loaders still read.
            VK_ICD_FILENAMES="$(echo ${pkgs.mesa}/share/vulkan/icd.d/lvp_icd.*.json)"
            export VK_ICD_FILENAMES
            export VK_DRIVER_FILES="$VK_ICD_FILENAMES"

            # Take the software paths directly instead of letting Mesa probe
            # for hardware, fail, and log its way down to them.
            export LIBGL_ALWAYS_SOFTWARE=1
            export GALLIUM_DRIVER=llvmpipe
            export GSK_RENDERER=cairo
            export WEBKIT_DISABLE_COMPOSITING_MODE=1
            export WEBKIT_DISABLE_DMABUF_RENDERER=1
          fi

          # No at-spi bus in a headless session.
          export NO_AT_BRIDGE=1
        '';

        commonBuildInputs = [
          wails3
          pkgs.go
          pkgs.go-task
          pkgs.gcc
          pkgs.pkg-config
          pkgs.gtk4
          pkgs.webkitgtk_6_0
          pkgs.nodejs
          pkgs.bun
          pkgs.sqlite
          pkgs.ffmpeg
          pkgs.imagemagick

          # Graphics stack. Nothing here pulls in a GPU: mesa carries the
          # llvmpipe/swrast DRI drivers and the lavapipe Vulkan ICD, which are
          # what GTK4 and WebKit fall back to when there is no render node.
          pkgs.mesa
          pkgs.libglvnd
          pkgs.libgbm
          pkgs.vulkan-loader

          # WebKit has no TLS backend of its own; without this every https://
          # fetch from the webview fails.
          pkgs.glib-networking

          # Virtual X server, for running the app with no display attached.
          pkgs.xvfb-run
        ];
      in
      {
        packages.wails3 = wails3;

        devShells.default = pkgs.mkShell {
          buildInputs = commonBuildInputs;
          shellHook = commonHook;
        };

        # GUI closure (Xvfb, xdotool, imagemagick) split out from `default`
        # so everyday development doesn't pay for it — see
        # docs/panel-unification-plan.md's e2e verification steps, which are
        # the only thing that needs this shell.
        devShells.e2e = pkgs.mkShell {
          buildInputs = commonBuildInputs ++ [
            pkgs.chromium
            pkgs.xvfb
            pkgs.xdpyinfo
            pkgs.xdotool
          ];
          shellHook = ''
            ${commonHook}
            export DISPLAY="''${DISPLAY:-:99}"
            export CHROMIUM_BIN="${pkgs.chromium}/bin/chromium"
          '';
        };

      });
}
