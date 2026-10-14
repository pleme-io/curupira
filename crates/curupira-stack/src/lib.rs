use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use curupira_sites::{Bundle, FormSignin, Posture, Profile, StackProvenance, Workspace, WorkspaceTab};
use figment::value::magic::RelativePathBuf;
use serde::Deserialize;

pub const APP: &str = "curupira-sites";
pub const ENV_PREFIX: &str = "CURUPIRA_SITES_STACK_";

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Stack {
    #[serde(default)]
    pub sites: BTreeMap<String, SiteEntry>,
    #[serde(default)]
    pub workspaces: BTreeMap<String, WorkspaceEntry>,
    #[serde(default)]
    pub postures: BTreeMap<String, PostureEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PostureEntry {
    #[serde(default = "on")]
    pub enabled: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub workspaces: Vec<String>,
    #[serde(default)]
    pub hours: Option<[u8; 2]>,
    #[serde(default)]
    pub days: Vec<u8>,
    #[serde(default = "thirty")]
    pub interval_minutes: u32,
    #[serde(default)]
    pub signin: BTreeMap<String, SigninEntry>,
    #[serde(default)]
    pub notify: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SigninEntry {
    #[serde(default = "on")]
    pub enabled: bool,
    #[serde(rename = "match")]
    pub match_url: String,
    pub user_file: String,
    pub password_file: String,
    #[serde(default)]
    pub user_selector: Option<String>,
    #[serde(default)]
    pub password_selector: Option<String>,
}

const fn thirty() -> u32 {
    30
}

#[derive(Debug, Clone, Deserialize)]
pub struct SiteEntry {
    #[serde(default = "on")]
    pub enabled: bool,
    #[serde(default)]
    pub file: Option<RelativePathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceEntry {
    #[serde(default = "on")]
    pub enabled: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tabs: BTreeMap<String, TabEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TabEntry {
    #[serde(default = "on")]
    pub enabled: bool,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub site: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub params: BTreeMap<String, String>,
    #[serde(default)]
    pub url: Option<String>,
}

const fn on() -> bool {
    true
}

pub fn layers(start: &Path) -> Result<Vec<PathBuf>, shikumi::ShikumiError> {
    match shikumi::ConfigDiscovery::new(APP)
        .hierarchical()
        .start_dir(start)
        .discover_all()
    {
        Ok(p) => Ok(p),
        Err(shikumi::ShikumiError::NotFound { .. }) => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

pub fn load(paths: &[PathBuf]) -> Result<Stack, shikumi::ShikumiError> {
    if paths.is_empty() {
        return Ok(Stack::default());
    }
    Ok(shikumi::ConfigStore::<Stack>::load_merged(paths, ENV_PREFIX)?
        .get()
        .as_ref()
        .clone())
}

pub fn compile(stack: &Stack, layers: &[PathBuf]) -> Bundle {
    let mut refused = Vec::new();
    let mut profiles: Vec<Profile> = Vec::new();

    for (id, entry) in stack.sites.iter().filter(|(_, e)| e.enabled) {
        let Some(file) = &entry.file else {
            refused.push(format!("site '{id}': enabled but no layer names its `file`"));
            continue;
        };
        let path = file.relative();
        let parsed = std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| Profile::from_yaml(&t).map_err(|e| e.to_string()))
            .and_then(|p| p.validate().map(|()| p).map_err(|e| e.to_string()));
        match parsed {
            Ok(p) if p.id() != id => refused.push(format!(
                "site '{id}': {} declares id '{}'; the stack key and the profile id must agree",
                path.display(),
                p.id()
            )),
            Ok(p) => profiles.push(p),
            Err(e) => refused.push(format!("site '{id}': {}: {e}", path.display())),
        }
    }

    let mut bundle = match Bundle::compile(&profiles) {
        Ok(b) => b,
        Err(e) => {
            refused.push(format!("bundle: {e}; no site loaded"));
            Bundle { schema_version: curupira_sites::toolgen::SCHEMA_VERSION, ..Bundle::default() }
        }
    };

    let by_id: BTreeMap<&str, &Profile> = profiles.iter().map(|p| (p.id(), p)).collect();
    for (name, ws) in stack.workspaces.iter().filter(|(_, w)| w.enabled) {
        let mut tabs: Vec<(&String, &TabEntry)> = ws.tabs.iter().filter(|(_, t)| t.enabled).collect();
        tabs.sort_by(|a, b| a.1.order.cmp(&b.1.order).then(a.0.cmp(b.0)));
        let resolved = tabs
            .into_iter()
            .filter_map(|(key, tab)| match resolve_tab(key, tab, &by_id) {
                Ok(t) => Some(t),
                Err(e) => {
                    refused.push(format!("workspace '{name}' tab '{key}': {e}"));
                    None
                }
            })
            .collect();
        bundle.workspaces.push(Workspace {
            name: name.clone(),
            description: ws.description.clone(),
            tabs: resolved,
        });
    }

    let ws_names: Vec<&str> = bundle.workspaces.iter().map(|w| w.name.as_str()).collect();
    for (name, p) in stack.postures.iter().filter(|(_, p)| p.enabled) {
        match check_posture(name, p, &ws_names) {
            Ok(()) => bundle.postures.push(Posture {
                name: name.clone(),
                description: p.description.clone(),
                workspaces: p.workspaces.clone(),
                hours: p.hours,
                days: p.days.clone(),
                interval_minutes: p.interval_minutes,
                signin: p
                    .signin
                    .values()
                    .filter(|s| s.enabled)
                    .map(|s| FormSignin {
                        match_url: s.match_url.clone(),
                        user_file: s.user_file.clone(),
                        password_file: s.password_file.clone(),
                        user_selector: s.user_selector.clone(),
                        password_selector: s.password_selector.clone(),
                    })
                    .collect(),
                notify: p.notify.clone(),
            }),
            Err(e) => refused.push(format!("posture '{name}': {e}")),
        }
    }

    bundle.stack = Some(StackProvenance {
        layers: layers.iter().map(|p| p.display().to_string()).collect(),
        refused,
    });
    bundle
}

fn check_posture(name: &str, p: &PostureEntry, workspaces: &[&str]) -> Result<(), String> {
    if let Some(missing) = p.workspaces.iter().find(|w| !workspaces.contains(&w.as_str())) {
        return Err(format!("names workspace '{missing}', which no layer defines or which is disabled"));
    }
    if let Some([from, to]) = p.hours {
        if from >= to || to > 24 {
            return Err(format!("hours [{from}, {to}] must satisfy from < to <= 24"));
        }
    }
    if let Some(d) = p.days.iter().find(|d| **d > 6) {
        return Err(format!("day {d} is not 0 (Sunday) to 6 (Saturday)"));
    }
    if p.interval_minutes == 0 {
        return Err(format!("{name}: interval_minutes must be at least 1"));
    }
    Ok(())
}

fn resolve_tab(key: &str, tab: &TabEntry, sites: &BTreeMap<&str, &Profile>) -> Result<WorkspaceTab, String> {
    match (&tab.site, &tab.url) {
        (Some(_), Some(_)) => Err("names both `site` and `url`; pick one".into()),
        (None, None) => Err("names neither `site` nor `url`".into()),
        (None, Some(url)) => Ok(WorkspaceTab { key: key.into(), url: url.clone(), site: None, page: None }),
        (Some(site), None) => {
            let Some(profile) = sites.get(site.as_str()) else {
                return Err(format!("site '{site}' is not an enabled, loaded site of this stack"));
            };
            let Profile::Browser(p) = profile else {
                return Err(format!("site '{site}' is a macos-app; open it with site_goto"));
            };
            let base = p.base_url.trim_end_matches('/');
            let url = match &tab.page {
                None => base.to_string(),
                Some(page) => {
                    let Some(pg) = p.pages.iter().find(|x| &x.name == page) else {
                        return Err(format!("site '{site}' has no page '{page}'"));
                    };
                    let mut route = pg.route.clone();
                    for (k, v) in &tab.params {
                        route = route.replace(&format!("{{{k}}}"), v);
                    }
                    if let Some(open) = route.find('{') {
                        return Err(format!("route '{}' still has an unfilled param at '{}'", pg.route, &route[open..]));
                    }
                    format!("{base}{route}")
                }
            };
            Ok(WorkspaceTab { key: key.into(), url, site: Some(site.clone()), page: tab.page.clone() })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PROFILE: &str = "id: logs\nbase_url: https://logs.example.invalid/\nmatch: [logs.example.invalid]\npages:\n  - name: search\n    route: /app/search?q={q}\n    ready: [!url-contains \"/app/search\"]\n";

    fn layered() -> (tempfile::TempDir, Vec<PathBuf>) {
        let root = tempfile::tempdir().unwrap();
        let user = root.path().join("user");
        let repo = root.path().join("repo");
        fs::create_dir_all(user.join("sites")).unwrap();
        fs::create_dir_all(&repo).unwrap();
        fs::write(user.join("sites/logs.yaml"), PROFILE).unwrap();
        fs::write(
            user.join("curupira-sites.yaml"),
            "sites:\n  logs: { file: sites/logs.yaml }\n  ghost: { file: sites/missing.yaml }\nworkspaces:\n  incident:\n    description: base\n    tabs:\n      logs: { site: logs, page: search, params: { q: error }, order: 1 }\n      status: { url: https://status.example.invalid, order: 2 }\n",
        )
        .unwrap();
        fs::write(
            repo.join(".curupira-sites.yaml"),
            "sites:\n  ghost: { enabled: false }\nworkspaces:\n  incident:\n    description: repo\n    tabs:\n      status: { enabled: false }\n      board: { url: https://board.example.invalid, order: 0 }\n      broken: { site: nope }\n",
        )
        .unwrap();
        let paths = vec![user.join("curupira-sites.yaml"), repo.join(".curupira-sites.yaml")];
        (root, paths)
    }

    #[test]
    fn postures_merge_per_field_and_a_bad_one_is_refused_alone() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a.yaml");
        let b = root.path().join("b.yaml");
        fs::write(
            &a,
            "workspaces:\n  morning: { tabs: { s: { url: https://status.example.invalid } } }\npostures:\n  warm:\n    workspaces: [morning]\n    hours: [8, 19]\n    days: [1, 2, 3, 4, 5]\n    signin:\n      logs: { match: logs.example.invalid, user_file: /u, password_file: /p }\n  broken:\n    workspaces: [nope]\n",
        )
        .unwrap();
        fs::write(&b, "postures:\n  warm:\n    interval_minutes: 15\n    signin:\n      logs: { enabled: false, match: x, user_file: x, password_file: x }\n").unwrap();
        let paths = vec![a, b];
        let bundle = compile(&load(&paths).unwrap(), &paths);
        assert_eq!(bundle.postures.len(), 1);
        let warm = &bundle.postures[0];
        assert_eq!(warm.name, "warm");
        assert_eq!(warm.workspaces, vec!["morning"]);
        assert_eq!(warm.hours, Some([8, 19]));
        assert_eq!(warm.interval_minutes, 15);
        assert!(warm.signin.is_empty(), "the higher layer configured the sign-in rule off");
        let refused = &bundle.stack.as_ref().unwrap().refused;
        assert!(refused.iter().any(|r| r.contains("posture 'broken'") && r.contains("nope")), "{refused:?}");
    }

    #[test]
    fn repo_layer_overrides_user_layer_per_key() {
        let (_root, paths) = layered();
        let b = compile(&load(&paths).unwrap(), &paths);
        assert_eq!(b.sites.len(), 1);
        let ws = &b.workspaces[0];
        assert_eq!(ws.description.as_deref(), Some("repo"));
        let keys: Vec<&str> = ws.tabs.iter().map(|t| t.key.as_str()).collect();
        assert_eq!(keys, ["board", "logs"]);
        assert_eq!(ws.tabs[1].url, "https://logs.example.invalid/app/search?q=error");
    }

    #[test]
    fn a_bad_entry_is_refused_alone() {
        let (_root, paths) = layered();
        let b = compile(&load(&paths).unwrap(), &paths);
        let refused = &b.stack.as_ref().unwrap().refused;
        assert_eq!(refused.len(), 1, "{refused:?}");
        assert!(refused[0].contains("tab 'broken'"));
        assert_eq!(b.workspaces[0].tabs.len(), 2);
    }

    #[test]
    fn a_missing_profile_file_does_not_take_down_its_siblings() {
        let (_root, mut paths) = layered();
        paths.pop();
        let b = compile(&load(&paths).unwrap(), &paths);
        assert_eq!(b.sites.len(), 1);
        assert!(b.stack.unwrap().refused.iter().any(|r| r.contains("site 'ghost'")));
    }

    #[test]
    fn hierarchical_discovery_finds_the_repo_layer_last() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("a/b");
        fs::create_dir_all(&repo).unwrap();
        fs::write(root.path().join("a/.curupira-sites.yaml"), "{}").unwrap();
        fs::write(repo.join(".curupira-sites.yaml"), "{}").unwrap();
        fs::write(repo.join(".curupira-sites-akeyless.yaml"), "{}").unwrap();
        let found = layers(&repo).unwrap();
        let tail: Vec<String> = found
            .iter()
            .rev()
            .take(3)
            .map(|p| p.strip_prefix(root.path()).unwrap_or(p).display().to_string())
            .collect();
        assert_eq!(tail, ["a/b/.curupira-sites-akeyless.yaml", "a/b/.curupira-sites.yaml", "a/.curupira-sites.yaml"]);
    }
}
