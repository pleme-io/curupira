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

      mcpServerUnwrapped = substrateLib.mkTypescriptToolAuto {
        src = self + "/mcp-server";
        plemeLinker = plemeLinkerPkg;
        parentTsconfig = self + "/tsconfig.json";
        workspaceRoot = self;
      };

      mcpServer = pkgs.runCommand "curupira-mcp-server" {
        nativeBuildInputs = [ pkgs.makeWrapper ];
        meta = (mcpServerUnwrapped.meta or { }) // { mainProgram = "curupira-mcp"; };
      } ''
        makeWrapper ${mcpServerUnwrapped}/bin/curupira-mcp $out/bin/curupira-mcp \
          --set-default CURUPIRA_AX_BIN ${curupiraAx}/bin/curupira-ax \
          --set-default CURUPIRA_STACK_BIN ${curupiraStack}/bin/curupira-stack
      '';

      # The profile compiler. Built with plain rustPlatform rather than
      # substrate's rust-tool flake builder: this is one small crate with a
      # committed Cargo.lock and no workspace-release machinery, and
      # substrate.rust.tool produces a whole flake output set that does not
      # compose with the eachDefaultSystem shape this flake already has.
      # One vendored lock, shared by both Rust packages. The workspace now carries
      # a git dependency (the generated akeyless-api SDK), which rustPlatform must
      # be given a hash for; defining it once keeps the two packages in lockstep.
      commonCargoLock = {
        lockFile = self + "/Cargo.lock";
        outputHashes = {
          "akeyless-api-0.1.1" = "sha256-5dmaCcMnO97hKzIS/qkgIqaCSWcTVTqQjajdZtD9PgI=";
        };
      };

      workspaceCrate = pname: description:
        pkgs.rustPlatform.buildRustPackage {
          inherit pname;
          version = "0.1.0";
          src = self;
          cargoLock = commonCargoLock;
          buildAndTestSubdir = "crates/${pname}";
          doCheck = true;
          meta = { inherit description; mainProgram = pname; };
        };

      curupiraSites = workspaceCrate "curupira-sites"
        "Compile web-console profiles into MCP tool definitions";
      curupiraAx = workspaceCrate "curupira-ax"
        "Drive native macOS app UI through the Accessibility API for curupira's macos-app site profiles";
      curupiraAkeyless = workspaceCrate "curupira-akeyless"
        "Typed, gated client for the akeyless API (wraps the generated akeyless-api SDK)";
      curupiraStack = workspaceCrate "curupira-stack"
        "Merge system, user and repo curupira site layers into one bundle";

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
        curupira-ax = curupiraAx;
        curupira-akeyless = curupiraAkeyless;
        curupira-stack = curupiraStack;
      };

      apps = {
        default = { type = "app"; program = "${mcpServer}/bin/curupira-mcp"; };
        mcp = { type = "app"; program = "${mcpServer}/bin/curupira-mcp"; };
        sites = { type = "app"; program = "${curupiraSites}/bin/curupira-sites"; };
        ax = { type = "app"; program = "${curupiraAx}/bin/curupira-ax"; };
        akeyless = { type = "app"; program = "${curupiraAkeyless}/bin/curupira-akeyless"; };
        stack = { type = "app"; program = "${curupiraStack}/bin/curupira-stack"; };
        "regen:all" = { type = "app"; program = "${regenApp}"; };
      };

      checks = {
        inherit mcpServer curupiraSites curupiraAx;
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
          curupira-ax = self.packages.${final.system}.curupira-ax;
          curupira-stack = self.packages.${final.system}.curupira-stack;
        };
        default = curupira;
      };
    };
}
