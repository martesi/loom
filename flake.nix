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
          version = "3.0.0-beta.4";

          src = pkgs.fetchFromGitHub {
            owner = "wailsapp";
            repo = "wails";
            rev = "v${version}";
            hash = "sha256-KKC0C3G4iuXXhD+3f/jEmaPp6SGLqsNdnvwvAd5EXZc=";
          };

          # The v3 module lives in a subdirectory of the repo.
          sourceRoot = "${src.name}/v3";
          subPackages = [ "cmd/wails3" ];
          vendorHash = "sha256-evBFmY8hyd0PqUbcoigZ/6h/j3k8pGJSqry45z6L/1k=";

          nativeBuildInputs = [ pkgs.pkg-config ];
          buildInputs = [ pkgs.gtk4 pkgs.webkitgtk_6_0 ];

          # The CLI embeds templates and task files; tests want a display.
          doCheck = false;
        };
      in
      {
        packages.wails3 = wails3;

        devShells.default = pkgs.mkShell {
          buildInputs = [
            wails3
            pkgs.go
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

          shellHook = ''
            export GOBIN="$PWD/.bin"
            export PATH="$GOBIN:$PATH"

            export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules''${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"

            # Everything below only applies when there is no DRM render node —
            # a real GPU host keeps its own hardware drivers untouched.
            if [ ! -e /dev/dri/renderD128 ]; then
              # Use this shell's Mesa rather than whatever the host exposes. The
              # host ICD set can be a single unusable driver (powervr on WSL),
              # which is what makes zink fail with "failed to choose pdev" and
              # EGL fall over with "failed to get driver name for fd -1".
              export LIBGL_DRIVERS_PATH="${pkgs.mesa}/lib/dri"
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
        };
      });
}
