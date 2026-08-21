use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio::process::Command;

use crate::{AdapterError, Config, SessionRuntimeConfig};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct OrcaClient {
    config: Config,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaRuntime {
    pub worktree_id: String,
    pub worktree_path: String,
    pub terminal_handle: String,
    pub cursor: String,
}

pub struct TerminalRead {
    pub lines: Vec<String>,
    pub next_cursor: String,
}

pub struct TerminalView {
    pub preview: String,
    pub ready_for_input: bool,
}

fn create_command_args(
    config: &Config,
    name: &str,
    prompt: &str,
    runtime: &SessionRuntimeConfig,
) -> Vec<String> {
    let repo_selector = runtime
        .repository_selector
        .as_deref()
        .unwrap_or(&config.repo_selector);
    let provider = runtime.provider.as_deref().unwrap_or("codex");
    let mut args = vec![
        "worktree".into(),
        "create".into(),
        "--repo".into(),
        repo_selector.to_owned(),
        "--name".into(),
        name.into(),
    ];
    let base_ref = if runtime.repository_selector.is_some() {
        runtime.base_ref.as_ref()
    } else {
        runtime.base_ref.as_ref().or(config.base_ref.as_ref())
    };
    if let Some(base_ref) = base_ref {
        args.push("--base-branch".into());
        args.push(base_ref.clone());
    }
    args.extend([
        "--agent".into(),
        provider.to_owned(),
        "--prompt".into(),
        prompt.into(),
        "--setup".into(),
        "skip".into(),
        "--no-parent".into(),
    ]);
    if let Some(model) = runtime.model.as_deref() {
        args.push("--model".into());
        args.push(model.to_owned());
    }
    args.push("--json".into());
    args
}

impl OrcaClient {
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    pub async fn create(
        &self,
        name: &str,
        prompt: &str,
        runtime: &SessionRuntimeConfig,
    ) -> Result<OrcaRuntime, AdapterError> {
        let create_args = create_command_args(&self.config, name, prompt, runtime);
        let value = self.run_json(create_args, COMMAND_TIMEOUT).await?;
        let worktree_id = required_string(&value, "/result/worktree/id", "worktree id")?;
        let worktree_path = required_string(&value, "/result/worktree/path", "worktree path")?;
        let terminal_handle = value
            .pointer("/result/agentTerminalHandle")
            .or_else(|| value.pointer("/result/startupTerminal/handle"))
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::Orca("worktree create omitted terminal handle".into()))?
            .to_owned();
        Ok(OrcaRuntime {
            worktree_id,
            worktree_path,
            terminal_handle,
            cursor: "0".into(),
        })
    }

    pub async fn send(&self, terminal_handle: &str, prompt: &str) -> Result<(), AdapterError> {
        let args = vec![
            "terminal".into(),
            "send".into(),
            "--terminal".into(),
            terminal_handle.into(),
            "--text".into(),
            prompt.into(),
            "--agent-prompt".into(),
            "--json".into(),
        ];
        let value = self.run_json(args, COMMAND_TIMEOUT).await?;
        if value
            .pointer("/result/send/accepted")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err(AdapterError::Orca(
                "Orca rejected terminal follow-up".into(),
            ));
        }
        Ok(())
    }

    pub async fn wait_idle(&self, terminal_handle: &str, timeout: Duration) -> bool {
        let timeout_ms = timeout.as_millis().min(u128::from(u64::MAX)).to_string();
        self.run_json(
            vec![
                "terminal".into(),
                "wait".into(),
                "--terminal".into(),
                terminal_handle.into(),
                "--for".into(),
                "tui-idle".into(),
                "--timeout-ms".into(),
                timeout_ms,
                "--json".into(),
            ],
            timeout.saturating_add(Duration::from_secs(2)),
        )
        .await
        .ok()
        .and_then(|value| {
            value
                .pointer("/result/wait/satisfied")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false)
    }

    pub async fn read(
        &self,
        terminal_handle: &str,
        cursor: &str,
    ) -> Result<TerminalRead, AdapterError> {
        let value = self
            .run_json(
                vec![
                    "terminal".into(),
                    "read".into(),
                    "--terminal".into(),
                    terminal_handle.into(),
                    "--cursor".into(),
                    cursor.into(),
                    "--limit".into(),
                    "12000".into(),
                    "--json".into(),
                ],
                COMMAND_TIMEOUT,
            )
            .await?;
        let lines = value
            .pointer("/result/terminal/tail")
            .and_then(Value::as_array)
            .ok_or_else(|| AdapterError::Orca("terminal read omitted tail".into()))?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let next_cursor = required_string(
            &value,
            "/result/terminal/nextCursor",
            "terminal next cursor",
        )?;
        Ok(TerminalRead { lines, next_cursor })
    }

    pub async fn verify(&self, terminal_handle: &str) -> Result<(), AdapterError> {
        self.show(terminal_handle).await.map(|_| ())
    }

    pub async fn show(&self, terminal_handle: &str) -> Result<TerminalView, AdapterError> {
        let value = self
            .run_json(
                vec![
                    "terminal".into(),
                    "show".into(),
                    "--terminal".into(),
                    terminal_handle.into(),
                    "--json".into(),
                ],
                COMMAND_TIMEOUT,
            )
            .await?;
        if value
            .pointer("/result/terminal/connected")
            .and_then(Value::as_bool)
            == Some(false)
        {
            return Err(AdapterError::Orca(
                "persisted Orca terminal is disconnected".into(),
            ));
        }
        let preview = value
            .pointer("/result/terminal/preview")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        Ok(TerminalView {
            ready_for_input: is_ready_for_input(&preview),
            preview,
        })
    }
    pub async fn stop(&self, worktree_id: &str) {
        let _ = self
            .run_json(
                vec![
                    "terminal".into(),
                    "stop".into(),
                    "--worktree".into(),
                    format!("id:{worktree_id}"),
                    "--json".into(),
                ],
                COMMAND_TIMEOUT,
            )
            .await;
    }

    pub async fn interrupt(&self, terminal_handle: &str) {
        let _ = self
            .run_json(
                vec![
                    "terminal".into(),
                    "send".into(),
                    "--terminal".into(),
                    terminal_handle.into(),
                    "--interrupt".into(),
                    "--json".into(),
                ],
                COMMAND_TIMEOUT,
            )
            .await;
    }

    async fn run_json(
        &self,
        command_args: Vec<String>,
        timeout: Duration,
    ) -> Result<Value, AdapterError> {
        let mut args = Vec::new();
        if let Some(environment) = &self.config.environment {
            args.push("--environment".into());
            args.push(environment.clone());
        }
        args.extend(command_args);

        let mut command = Command::new(&self.config.orca_cli);
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let output = tokio::time::timeout(timeout, command.output())
            .await
            .map_err(|_| {
                AdapterError::Orca(format!("orca command timed out: {}", args.join(" ")))
            })??;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            let detail = serde_json::from_slice::<Value>(&output.stdout)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .or_else(|| value.pointer("/error"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .filter(|message| !message.is_empty())
                .or_else(|| (!stderr.is_empty()).then_some(stderr))
                .or_else(|| (!stdout.is_empty()).then_some(stdout))
                .unwrap_or_else(|| format!("exit status {}", output.status));
            return Err(AdapterError::Orca(format!(
                "orca command failed ({}): {detail}",
                args.join(" ")
            )));
        }
        parse_json(&output.stdout)
    }
}

fn is_ready_for_input(preview: &str) -> bool {
    let last_ready = [
        "Ask Codex to do anything",
        "Run /review on my current changes",
    ]
    .into_iter()
    .filter_map(|marker| preview.rfind(marker))
    .max();
    let last_busy = preview
        .rfind("esc to interrupt")
        .into_iter()
        .chain(preview.rfind("Working"))
        .max();
    matches!((last_ready, last_busy), (Some(ready), Some(busy)) if ready > busy)
        || matches!((last_ready, last_busy), (Some(_), None))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::time::Duration;

    use super::{create_command_args, is_ready_for_input, Config, SessionRuntimeConfig};

    fn config() -> Config {
        Config {
            orca_cli: "orca".into(),
            environment: None,
            repo_selector: "id:default-repo".into(),
            base_ref: None,
            state_file: PathBuf::from("/tmp/buzz-orca-test.json"),
            max_concurrent_turns: 1,
            poll_interval: Duration::from_millis(1),
            turn_timeout: Duration::from_secs(1),
            allowed_conversations: HashSet::new(),
            allowed_repo_selectors: HashSet::from(["id:default-repo".into()]),
            allowed_providers: HashSet::from(["codex".into()]),
        }
    }

    #[test]
    fn forwards_selected_repo_provider_and_model() {
        let args = create_command_args(
            &config(),
            "chat-one",
            "fix it",
            &SessionRuntimeConfig {
                base_ref: None,
                repository_selector: Some("id:selected-repo".into()),
                provider: Some("codex".into()),
                model: Some("gpt-5.2-codex".into()),
            },
        );
        assert_eq!(
            args,
            vec![
                "worktree",
                "create",
                "--repo",
                "id:selected-repo",
                "--name",
                "chat-one",
                "--agent",
                "codex",
                "--prompt",
                "fix it",
                "--setup",
                "skip",
                "--no-parent",
                "--model",
                "gpt-5.2-codex",
                "--json",
            ]
        );
    }

    #[test]
    fn applies_selected_repo_base_ref() {
        let mut config = config();
        config.base_ref = Some("feat/default-repo".into());
        let args = create_command_args(
            &config,
            "chat-one",
            "fix it",
            &SessionRuntimeConfig {
                base_ref: Some("main".into()),
                repository_selector: Some("id:selected-repo".into()),
                provider: Some("codex".into()),
                model: None,
            },
        );

        assert!(args
            .windows(2)
            .any(|pair| pair == ["--base-branch", "main"]));
        assert!(!args.contains(&"feat/default-repo".to_owned()));
    }

    #[test]
    fn recognizes_current_codex_idle_prompt() {
        assert!(is_ready_for_input(
            "• Working (2s • esc to interrupt)\n• ## Heading\n›Run /review on my current changes"
        ));
    }

    #[test]
    fn does_not_treat_busy_preview_as_idle() {
        assert!(!is_ready_for_input(
            "›Run /review on my current changes\n• Working (2s • esc to interrupt)"
        ));
    }
}

fn parse_json(stdout: &[u8]) -> Result<Value, AdapterError> {
    let raw = String::from_utf8_lossy(stdout);
    let start = raw
        .find('{')
        .ok_or_else(|| AdapterError::Orca("orca command returned no JSON".into()))?;
    let end = raw
        .rfind('}')
        .ok_or_else(|| AdapterError::Orca("orca command returned incomplete JSON".into()))?;
    let value: Value = serde_json::from_str(&raw[start..=end])?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(AdapterError::Orca(format!("orca command failed: {value}")));
    }
    Ok(value)
}

fn required_string(value: &Value, pointer: &str, label: &str) -> Result<String, AdapterError> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| AdapterError::Orca(format!("orca command omitted {label}")))
}
