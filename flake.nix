{
  description = "Curupira MCP debugging server for React apps";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
    substrate = {
      url = "git+ssh://git@github.com/pleme-io/substrate.git";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    pleme-linker = {
      url = "git+ssh://git@github.com/pleme-io/pleme-linker.git";
    };
    devenv = {
      url = "github:cachix/devenv";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, flake-utils, substrate, pleme-linker, self, ... }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};

      substrateLib = substrate.libFor {
        inherit pkgs system;
      };

      plemeLinkerPkg = pleme-linker.packages.${system}.default;

      mcpServer = substrateLib.mkTypescriptToolAuto {
        src = self + "/mcp-server";
        plemeLinker = plemeLinkerPkg;
        parentTsconfig = self + "/tsconfig.json";
        workspaceRoot = self;
      };

      regenApp = substrateLib.mkTypescriptRegenApp {
        name = "curupira";
        plemeLinker = plemeLinkerPkg;
        projectDirs = [ (self + "/shared") (self + "/mcp-server") ];
      };

    in {
      packages = {
        default = mcpServer;
        mcp-server = mcpServer;
      };

      apps = {
        default = { type = "app"; program = "${mcpServer}/bin/curupira-mcp"; };
        mcp = { type = "app"; program = "${mcpServer}/bin/curupira-mcp"; };
        "regen:all" = { type = "app"; program = "${regenApp}"; };
      };

      devShells.default = pkgs.mkShell {
        buildInputs = with pkgs; [ nodejs_20 ];
        nativeBuildInputs = [ plemeLinkerPkg ];
        shellHook = ''
          echo "Curupira development environment"
          echo "  pleme-linker resolve --project shared       - Regenerate shared/deps.nix"
          echo "  pleme-linker resolve --project mcp-server   - Regenerate mcp-server/deps.nix"
          echo "  nix build .#mcp-server                      - Build the MCP server"
        '';
      };
    });
}
