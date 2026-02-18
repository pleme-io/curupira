{
  description = "Curupira MCP debugging server for React apps";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, self, ... }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};

      # Import nix-lib for TypeScript tool building
      nixLib = import (self + "/../../../products/novaskyn/services/rust/nix-lib/lib") {
        inherit pkgs;
      };

      # Build pleme-linker
      plemeLinker = nixLib.mkPlemeLinker {
        plemeLinkerSrc = self + "/../../rust/pleme-linker";
      };

      # Build curupira-mcp-server - auto-discovers everything from package.json and deps.nix
      mcpServer = nixLib.mkTypescriptToolAuto {
        src = self + "/mcp-server";
        inherit plemeLinker;
        parentTsconfig = self + "/tsconfig.json";
        workspaceRoot = self;  # For resolving workspace packages like @curupira/shared
      };

      # Regeneration app
      regenApp = nixLib.mkTypescriptRegenApp {
        name = "curupira";
        inherit plemeLinker;
        projectDirs = [ (self + "/shared") (self + "/mcp-server") ];
      };

    in {
      packages = {
        mcp-server = mcpServer;
        default = mcpServer;
        pleme-linker = plemeLinker;
      };

      apps = {
        mcp = { type = "app"; program = "${mcpServer}/bin/curupira-mcp"; };
        default = { type = "app"; program = "${mcpServer}/bin/curupira-mcp"; };
        "regen:all" = { type = "app"; program = "${regenApp}"; };
      };

      devShells.default = pkgs.mkShell {
        buildInputs = with pkgs; [ nodejs_20 ];
        nativeBuildInputs = [ plemeLinker ];
        shellHook = ''
          echo "Curupira development environment"
          echo "  pleme-linker resolve --project shared       - Regenerate shared/deps.nix"
          echo "  pleme-linker resolve --project mcp-server   - Regenerate mcp-server/deps.nix"
          echo "  nix build .#mcp-server                      - Build the MCP server"
        '';
      };
    });
}
