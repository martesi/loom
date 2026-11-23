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

        # Wails v3 CLI. nixpkgs carries it as pkgs.wails3, pinned here via
        # flake.lock — keep that in lockstep with github.com/wailsapp/wails/v3
        # in go.mod: the CLI generates and consumes code that the library
        # must agree with.
        baseHook = ''
          export GOBIN="$PWD/.bin"
          export PATH="$GOBIN:$PATH"

          export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules''${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"

          # The purego backend (-tags purego) loads GTK/WebKit via dlopen of
          # bare sonames, which know nothing of the Nix store. Point the
          # loader at the libraries the app needs (transitive deps resolve
          # via the RUNPATH baked into those .so files). Harmless for cgo
          # binaries, which carry their own RPATH.
          export LD_LIBRARY_PATH="${pkgs.gtk4}/lib:${pkgs.webkitgtk_6_0}/lib:${pkgs.glib.out}/lib:${pkgs.libsoup_3}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

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

          # No at-spi bus in a headless session.
          export NO_AT_BRIDGE=1
        '';

        softwareHook = ''
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
        '';

        e2ePackages = [
          pkgs.chromium
          pkgs.xvfb
          pkgs.xdpyinfo
          pkgs.xdotool
          # `import` for screenshots (see .agents/skills/e2e/references/).
          pkgs.imagemagick
        ];

        wslGpuChromium = pkgs.writeShellScript "chromium-wsl-gpu" ''
          exec ${pkgs.chromium}/bin/chromium --ozone-platform=x11 --use-gl=angle --use-angle=gl "$@"
        '';

        gpuHook = ''
          unset LIBGL_ALWAYS_SOFTWARE LIBGL_DRIVERS_PATH __EGL_VENDOR_LIBRARY_FILENAMES
          unset VK_ICD_FILENAMES VK_DRIVER_FILES GSK_RENDERER
          unset WEBKIT_DISABLE_COMPOSITING_MODE WEBKIT_DISABLE_DMABUF_RENDERER WAYLAND_DISPLAY
          export GALLIUM_DRIVER=d3d12
          export LD_LIBRARY_PATH="/run/opengl-driver/lib:/usr/lib/wsl/lib:$LD_LIBRARY_PATH"
          export __EGL_VENDOR_LIBRARY_DIRS=/run/opengl-driver/share/glvnd/egl_vendor.d
          export DISPLAY="''${DISPLAY:-:99}"
          export CHROMIUM_BIN="${wslGpuChromium}"
        '';

        commonBuildInputs = [
          # wails3 CLI (dev server, bindings, packaging). Library itself comes
          # from go.mod via `go build`.
          pkgs.wails3
          pkgs.go
          pkgs.go-task
          # No gcc / pkg-config / gtk / webkit declarations: gtk4 and
          # webkitgtk_6_0 arrive via pkgs.wails3's propagated inputs, and the
          # shellHook path refs below pin them into the closure for purego's
          # dlopen. Default builds are purego or server (both CGO_ENABLED=0),
          # so no C toolchain is needed. (Note: stdenv always provides a cc,
          # so the CGO=true opt-out keeps working regardless.)
          # Both: bun builds/tests the frontend, node runs the agent harness
          # (`node .agents/skills/e2e/scripts/harness.ts`) and Playwright.
          pkgs.nodejs
          pkgs.bun
          # Runtime dep: internal/media/processor.go shells out to ffmpeg for
          # transcoding/thumbnails (docs/init.md). Tests skip if absent.
          pkgs.ffmpeg

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
        devShells.default = pkgs.mkShell {
          buildInputs = commonBuildInputs;
          shellHook = baseHook + softwareHook;
        };

        # GUI/test closure (Xvfb, xdotool, screenshots) split out from `default`
        # so everyday development doesn't pay for it — see
        # docs/panel-unification-plan.md's e2e verification steps, which are
        # the only thing that needs this shell.
        devShells.e2e = pkgs.mkShell {
          buildInputs = commonBuildInputs ++ e2ePackages;
          shellHook = baseHook + softwareHook + ''
            export DISPLAY="''${DISPLAY:-:99}"
            export CHROMIUM_BIN="${pkgs.chromium}/bin/chromium"
          '';
        };

        devShells.e2e-wsl-gpu = pkgs.mkShell {
          buildInputs = commonBuildInputs ++ e2ePackages;
          shellHook = baseHook + gpuHook;
        };

      });
}
