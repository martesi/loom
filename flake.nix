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
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
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
          ];

          shellHook = ''
            export GOBIN="$PWD/.bin"
            export PATH="$GOBIN:$PATH"
          '';
        };
      });
}
