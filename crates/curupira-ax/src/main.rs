use std::io::Read as _;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use curupira_ax::exec::{self, Request, Response, TestsRequest, Verb};
use curupira_ax::system::SystemHost;
use curupira_ax::tree::Walk;
use curupira_sites::Profile;

#[derive(Parser)]
#[command(
    name = "curupira-ax",
    about = "Drive native macOS app UI through the Accessibility API. JSON requests on stdin, one typed JSON outcome on stdout."
)]
struct Cli {
    #[arg(long, global = true)]
    pretty: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    #[command(about = "Whether this process may use Accessibility, and which app the grant belongs to")]
    Trusted,
    #[command(about = "Dump a bounded AX tree of a running app, for authoring a profile")]
    Survey {
        #[arg(long)]
        bundle_id: String,
        #[arg(long, default_value_t = 12)]
        depth: usize,
        #[arg(long, default_value_t = 600)]
        nodes: usize,
        #[arg(long)]
        launch: bool,
    },
    #[command(about = "Bring the app forward and wait for a view's ready signals; stdin {bundle_id, op:{op:\"ready\",...}, launch?}")]
    Goto,
    #[command(about = "Run one read; stdin {bundle_id, op:{op:\"read\",...}}")]
    Read,
    #[command(about = "Press or set a value; stdin {bundle_id, op:{op:\"act\",...}, value?}; a mutating action needs --authorized-by")]
    Act {
        #[arg(long)]
        authorized_by: Option<String>,
    },
    #[command(about = "Run a qualifying suite; stdin {bundle_id, tests:[...]} or --profile FILE")]
    RunTests {
        #[arg(long)]
        profile: Option<PathBuf>,
        #[arg(long)]
        launch: bool,
    },
}

fn stdin_json<T: serde::de::DeserializeOwned>() -> Result<T, Box<Response>> {
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| Box::new(Response::InvalidRequest { message: format!("reading stdin: {e}") }))?;
    serde_json::from_str(&buf)
        .map_err(|e| Box::new(Response::InvalidRequest { message: format!("request: {e}") }))
}

fn tests_from_profile(path: &PathBuf, launch: bool) -> Result<TestsRequest, Box<Response>> {
    let invalid = |message: String| Box::new(Response::InvalidRequest { message });
    let text = std::fs::read_to_string(path).map_err(|e| invalid(format!("{}: {e}", path.display())))?;
    match Profile::from_yaml(&text).map_err(|e| invalid(format!("{}: {e}", path.display())))? {
        Profile::MacosApp(p) => Ok(TestsRequest {
            bundle_id: p.bundle_id.clone(),
            tests: curupira_sites::testplan::compile_app(&p),
            launch,
            timeout_ms: None,
        }),
        Profile::Browser(p) => Err(invalid(format!(
            "'{}' is a browser profile; curupira-ax runs macos-app profiles",
            p.id
        ))),
    }
}

fn run(cmd: Cmd, host: &SystemHost) -> Response {
    let verb = |v: Verb, grant: Option<&str>| match stdin_json::<Request>() {
        Ok(req) => exec::execute(host, v, &req, grant),
        Err(r) => *r,
    };
    match cmd {
        Cmd::Trusted => exec::trusted(host),
        Cmd::Survey { bundle_id, depth, nodes, launch } => {
            exec::survey_app(host, &bundle_id, launch, Walk { max_nodes: nodes, max_depth: depth })
        }
        Cmd::Goto => verb(Verb::Goto, None),
        Cmd::Read => verb(Verb::Read, None),
        Cmd::Act { authorized_by } => verb(Verb::Act, authorized_by.as_deref()),
        Cmd::RunTests { profile, launch } => {
            let req = match &profile {
                Some(p) => tests_from_profile(p, launch),
                None => stdin_json::<TestsRequest>(),
            };
            match req {
                Ok(r) => exec::run_tests(host, &r),
                Err(r) => *r,
            }
        }
    }
}

fn main() {
    let cli = Cli::parse();
    let host = SystemHost::default();
    let response = run(cli.cmd, &host);
    let out = if cli.pretty {
        serde_json::to_string_pretty(&response)
    } else {
        serde_json::to_string(&response)
    };
    match out {
        Ok(s) => println!("{s}"),
        Err(e) => {
            eprintln!("curupira-ax: could not encode the outcome: {e}");
            std::process::exit(70);
        }
    }
    std::process::exit(response.exit_code());
}
