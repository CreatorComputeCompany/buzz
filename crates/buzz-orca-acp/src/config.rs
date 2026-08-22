use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use crate::AdapterError;

const DEFAULT_MAX_CONCURRENT_TURNS: usize = 2;
const DEFAULT_POLL_INTERVAL_MS: u64 = 1_000;
const DEFAULT_TURN_TIMEOUT_SECS: u64 = 1_800;

#[derive(Clone, Debug)]
pub struct Config {
    pub orca_cli: String,
    pub environment: Option<String>,
    pub repo_selector: String,
    pub base_ref: Option<String>,
    pub state_file: PathBuf,
    pub max_concurrent_turns: usize,
    pub poll_interval: Duration,
    pub turn_timeout: Duration,
    pub allowed_conversations: HashSet<String>,
    pub allowed_repo_selectors: HashSet<String>,
    pub allowed_providers: HashSet<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, AdapterError> {
        let repo_selector = required("BUZZ_ORCA_REPO_SELECTOR")?;
        let max_concurrent_turns = parse_env(
            "BUZZ_ORCA_MAX_CONCURRENT_TURNS",
            DEFAULT_MAX_CONCURRENT_TURNS,
        )?;
        if max_concurrent_turns == 0 {
            return Err(AdapterError::Config(
                "BUZZ_ORCA_MAX_CONCURRENT_TURNS must be greater than zero".into(),
            ));
        }

        let allowed_repo_selectors = optional("BUZZ_ORCA_ALLOWED_REPO_SELECTORS")
            .map(|raw| comma_separated(&raw))
            .unwrap_or_else(|| HashSet::from([repo_selector.clone()]));
        let allowed_providers = optional("BUZZ_ORCA_ALLOWED_PROVIDERS")
            .map(|raw| comma_separated(&raw))
            .unwrap_or_else(|| HashSet::from(["codex".to_owned()]));

        Ok(Self {
            orca_cli: std::env::var("BUZZ_ORCA_CLI").unwrap_or_else(|_| "orca".into()),
            environment: optional("BUZZ_ORCA_ENVIRONMENT"),
            repo_selector,
            base_ref: optional("BUZZ_ORCA_BASE_REF"),
            state_file: PathBuf::from(
                std::env::var("BUZZ_ORCA_STATE_FILE")
                    .unwrap_or_else(|_| "/var/lib/buzz-orca-acp/sessions.json".into()),
            ),
            max_concurrent_turns,
            poll_interval: Duration::from_millis(parse_env(
                "BUZZ_ORCA_POLL_INTERVAL_MS",
                DEFAULT_POLL_INTERVAL_MS,
            )?),
            turn_timeout: Duration::from_secs(parse_env(
                "BUZZ_ORCA_TURN_TIMEOUT_SECS",
                DEFAULT_TURN_TIMEOUT_SECS,
            )?),
            allowed_conversations: optional("BUZZ_ORCA_ALLOWED_CONVERSATIONS")
                .map(|raw| comma_separated(&raw))
                .unwrap_or_default(),
            allowed_repo_selectors,
            allowed_providers,
        })
    }

    pub fn conversation_allowed(&self, conversation_key: &str) -> bool {
        self.allowed_conversations.is_empty()
            || self.allowed_conversations.contains(conversation_key)
    }

    pub fn repo_allowed(&self, repo_selector: &str) -> bool {
        self.allowed_repo_selectors.contains(repo_selector)
    }

    pub fn provider_allowed(&self, provider: &str) -> bool {
        self.allowed_providers.contains(provider)
    }
}

fn comma_separated(raw: &str) -> HashSet<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn required(name: &str) -> Result<String, AdapterError> {
    optional(name).ok_or_else(|| AdapterError::Config(format!("{name} is required")))
}

fn optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn parse_env<T>(name: &str, default: T) -> Result<T, AdapterError>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match optional(name) {
        Some(raw) => raw
            .parse()
            .map_err(|error| AdapterError::Config(format!("{name}: {error}"))),
        None => Ok(default),
    }
}
