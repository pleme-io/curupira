# curupira — home-manager module.
#
# Wraps the MCP server and, more importantly, the SITE PROFILES it drives.
#
# The point of declaring profiles here rather than leaving YAML in
# ~/.config/curupira/sites is that a profile describing a third-party console is
# exactly the kind of thing that should be VERSIONED IN A PRIVATE REPO and
# rendered, not edited in place on one machine. Declared here, a profile is
# reviewable, reproducible, and cannot drift between machines — and the bundle
# the server loads is built in the nix store from that declaration, so what runs
# is what was declared.
#
# Nothing in this module names a host. A consumer supplies profiles; a private
# module in a private repo is the right place for a real one.
{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.curupira;

  # One declared profile -> a YAML file. `id` defaults to the attribute name, so
  # the common case needs no repetition and the two cannot disagree.
  profileFile = name: value:
    pkgs.writeText "curupira-site-${name}.yaml"
      (builtins.toJSON ({ id = name; } // value));
  # YAML is a superset of JSON, so toJSON is a valid profile document and avoids
  # hand-rolling a YAML emitter — which would be a second, worse serializer.

  profilesDir = pkgs.runCommand "curupira-sites-profiles" { } ''
    mkdir -p $out
    ${lib.concatStringsSep "\n" (
      (lib.mapAttrsToList (name: value: "cp ${profileFile name value} $out/${name}.yaml") cfg.sites)
      ++ (lib.mapAttrsToList (name: file: "cp ${file} $out/${name}.yaml") cfg.siteFiles)
    )}
  '';

  # The bundle is COMPILED, not hand-written, and compiling runs `check` first —
  # so a profile that would silently misbehave (a page with reads but no
  # DOM-based ready signal, a duplicate name, a tool-name collision) fails the
  # BUILD rather than being discovered at runtime on someone else's console.
  builtBundle = pkgs.runCommand "curupira-sites-bundle.json"
    { nativeBuildInputs = [ cfg.sitesPackage ]; } ''
    curupira-sites check ${profilesDir}
    curupira-sites build ${profilesDir} -o $out
  '';

  hasProfiles = cfg.sites != { } || cfg.siteFiles != { };
  bundlePath = if hasProfiles then builtBundle else null;
in
{
  options.programs.curupira = {
    enable = lib.mkEnableOption "curupira MCP debugging server";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.mcp-server;
      description = "The curupira MCP server package.";
    };

    sitesPackage = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.curupira-sites;
      description = "The curupira-sites profile compiler.";
    };

    sites = lib.mkOption {
      type = lib.types.attrsOf (lib.types.attrsOf lib.types.anything);
      default = { };
      example = lib.literalExpression ''
        {
          example-console = {
            base_url = "https://console.example.invalid";
            match = [ "console.example.invalid" ];
            pages = [{
              name = "home";
              route = "/home";
              ready = [ { selector-present = "#app"; } ];
              reads = [{ name = "heading"; locator = { selector = "h1"; }; kind = { text = null; }; }];
            }];
          };
        }
      '';
      description = ''
        Console profiles, keyed by id. Compiled into a bundle at build time.

        A profile describing a third-party console belongs in a PRIVATE
        repository — its routes and menu structure describe someone else's
        system. Declaring it means it is reviewed and reproducible rather than a
        loose file on one machine.

        Every profile is validated at build time, so a malformed or
        silently-wrong one fails the rebuild instead of the console.
      '';
    };

    siteFiles = lib.mkOption {
      type = lib.types.attrsOf lib.types.path;
      default = { };
      example = lib.literalExpression ''{ my-console = ./profiles/my-console.yaml; }'';
      description = ''
        Console profiles supplied as YAML FILES, keyed by id.

        The counterpart to `sites`, and usually the better one for a real
        profile: profiles are authored in YAML, reviewed as YAML, and produced as
        YAML by `curupira-sites draft`. Round-tripping one through Nix attributes
        to get it back out as YAML converts it twice for no gain and loses
        comments — which in a profile carry the measurements behind each
        selector.

        Both options feed the same compiler and the same validation.
      '';
    };

    bundle = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      readOnly = true;
      default = bundlePath;
      description = ''
        The compiled bundle, derived from `sites`. Read-only: it is a function of
        the declaration, so it cannot disagree with it.
      '';
    };

    cdpTimeoutMs = lib.mkOption {
      type = lib.types.int;
      default = 60000;
      description = ''
        Timeout for CDP evaluations, in milliseconds.

        The default of 10000 in curupira's own config is too low for real work:
        a page-ready wait or a settled survey legitimately takes longer, and the
        failure surfaces as a misleading "Command timeout" rather than as a slow
        page.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package cfg.sitesPackage ];

    home.sessionVariables = {
      CURUPIRA_CDP_TIMEOUT = toString cfg.cdpTimeoutMs;
    } // lib.optionalAttrs (cfg.bundle != null) {
      CURUPIRA_SITES_BUNDLE = cfg.bundle;
    };

    # The bundle is also linked to the path the server looks in by default, so a
    # consumer that launches it without the environment variable still gets the
    # declared profiles rather than silently none.
    xdg.configFile = lib.optionalAttrs (cfg.bundle != null) {
      "curupira/sites.bundle.json".source = cfg.bundle;
    };
  };
}
