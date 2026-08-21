{
  description = "Curupira — MCP debugging server for web apps, with declarative console site-plugins";

  inputs = {
    nixpkgs.follows = "substrate/nixpkgs";
    flake-utils.url = "github:numtide/flake-utils";
    substrate = {
      url = "github:pleme-io/substrate";
    };
    pleme-linker = {
      url = "github:pleme-io/pleme-linker";
    };
    devenv = {
      url = "github:cachix/devenv";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, flake-utils, substrate, pleme-linker, self, ... }:
    # Per-system outputs first; the module and overlay are system-independent and
    # are merged in below, because a home-manager module resolves its own pkgs
    # and must not be namespaced by system.
    (flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};

      substrateLib = substrate.libFor { inherit pkgs system; };
      plemeLinkerPkg = pleme-linker.packages.${system}.default;

      mcpServer = substrateLib.mkTypescriptToolAuto {
        src = self + "/mcp-server";
        plemeLinker = plemeLinkerPkg;
        parentTsconfig = self + "/tsconfig.json";
        workspaceRoot = self;
      };

      # The profile compiler. Built with plain rustPlatform rather than
      # substrate's rust-tool flake builder: this is one small crate with a
      # committed Cargo.lock and no workspace-release machinery, and
      # substrate.rust.tool produces a whole flake output set that does not
      # compose with the eachDefaultSystem shape this flake already has.
      curupiraSites = pkgs.rustPlatform.buildRustPackage {
        pname = "curupira-sites";
        version = "0.1.0";
        src = self;
        cargoLock.lockFile = self + "/Cargo.lock";
        # The crate is pure and its tests need no browser or network, so they run
        # as part of the build rather than being trusted to CI.
        doCheck = true;
        meta = {
          description = "Compile web-console profiles into MCP tool definitions";
          mainProgram = "curupira-sites";
        };
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
        curupira-sites = curupiraSites;
      };

      apps = {
        default = { type = "app"; program = "${mcpServer}/bin/curupira-mcp"; };
        mcp = { type = "app"; program = "${mcpServer}/bin/curupira-mcp"; };
        sites = { type = "app"; program = "${curupiraSites}/bin/curupira-sites"; };
        "regen:all" = { type = "app"; program = "${regenApp}"; };
      };

      checks = {
        inherit mcpServer curupiraSites;
      };

      devShells.default = pkgs.mkShell {
        # nodejs_22, not _20. nixpkgs marks nodejs-20 insecure now that it is end
        # of life, so a shell pinning it refuses to evaluate.
        buildInputs = with pkgs; [ nodejs_22 cargo rustc ];
        nativeBuildInputs = [ plemeLinkerPkg ];
        shellHook = ''
          echo "Curupira development environment"
          echo "  nix build .#mcp-server       - the MCP server"
          echo "  nix build .#curupira-sites   - the profile compiler"
          echo "  nix run   .#sites -- --help  - compile console profiles"
          echo "  nix run   .#\"regen:all\"      - regenerate deps.nix after npm changes"
        '';
      };
    })) // {
      # ── System-independent outputs ────────────────────────────────────────
      #
      # The home-manager module wraps both halves: the server, and the site
      # profiles it drives. Profiles are DECLARED and compiled at build time, so
      # a real one lives in a private repo and is reviewed, rather than being a
      # loose YAML file on one machine that nothing validates.
      homeManagerModules = rec {
        curupira = import ./modules/home-manager.nix { inherit self; };
        default = curupira;
      };

      overlays = rec {
        curupira = final: prev: {
          curupira-mcp = self.packages.${final.system}.mcp-server;
          curupira-sites = self.packages.${final.system}.curupira-sites;
        };
        default = curupira;
      };
    };
}
