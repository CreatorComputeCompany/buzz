const ANSWER_PREFIX: &str = "• ";

pub fn has_turn_activity(lines: &[String]) -> bool {
    lines
        .iter()
        .filter_map(|line| clean_line(line))
        .any(|line| {
            line == "• Working"
                || line.contains("esc to interrupt")
                || is_activity_line(line.trim())
        })
}

pub fn extract_final_agent_message(lines: &[String]) -> Option<String> {
    let cleaned: Vec<String> = lines.iter().filter_map(|line| clean_line(line)).collect();
    let working_index = cleaned
        .iter()
        .rposition(|line| line == "• Working" || line.contains("esc to interrupt"));
    let start = working_index.map_or(0, |index| index.saturating_add(1));

    for index in (start..cleaned.len()).rev() {
        let line = cleaned[index].trim();
        if !line.starts_with(ANSWER_PREFIX) || is_activity_line(line) {
            continue;
        }
        let mut answer = line.trim_start_matches(ANSWER_PREFIX).trim().to_owned();
        for continuation in &cleaned[index + 1..] {
            let continuation = continuation.trim_end();
            if continuation.starts_with("› ")
                || continuation.starts_with(ANSWER_PREFIX)
                || is_separator(continuation)
            {
                break;
            }
            if !continuation.is_empty() {
                answer.push('\n');
                answer.push_str(continuation);
            }
        }
        if !answer.is_empty() {
            return Some(answer);
        }
    }
    None
}

fn clean_line(raw: &str) -> Option<String> {
    let mut line = raw
        .chars()
        .filter(|character| !character.is_control() || *character == '\t')
        .collect::<String>();
    if let Some(footer) = line.rfind("  › Ask Codex") {
        line.truncate(footer);
    }
    let line = line.trim_end().to_owned();
    let trimmed = line.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('╭')
        || trimmed.starts_with('╰')
        || trimmed.starts_with('│')
        || trimmed.starts_with("Tip:")
        || trimmed.contains("OpenAI Codex")
        || is_separator(trimmed)
    {
        return None;
    }
    if trimmed.matches("Working").count() > 1
        || (trimmed.contains("esc to interrupt") && trimmed.contains("Working"))
    {
        return Some("• Working".into());
    }
    Some(line)
}

fn is_activity_line(line: &str) -> bool {
    [
        "• Working",
        "• Starting",
        "• Booting",
        "• Reconnecting",
        "• Ran",
        "• Explored",
        "• Called",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn is_separator(line: &str) -> bool {
    line.chars().count() >= 8
        && line
            .chars()
            .all(|character| matches!(character, '─' | '━' | '═' | '_' | '—' | '-'))
}

#[cfg(test)]
mod tests {
    use super::{extract_final_agent_message, has_turn_activity};

    #[test]
    fn distinguishes_prompt_echoes_from_started_turns() {
        assert!(!has_turn_activity(&["› follow-up task".into()]));
        assert!(has_turn_activity(&[
            "› follow-up task".into(),
            "• Working (0s • esc to interrupt) WorkingWorking".into(),
        ]));
    }

    #[test]
    fn extracts_answer_after_working_state() {
        let lines = vec![
            "› inspect the repo".into(),
            "• Working".into(),
            "• Explored".into(),
            "  └ Read README.md".into(),
            "• The repository is ready.".into(),
            "  Second line.".into(),
        ];
        assert_eq!(
            extract_final_agent_message(&lines).as_deref(),
            Some("The repository is ready.\n  Second line.")
        );
    }

    #[test]
    fn ignores_prompt_and_activity_redraws() {
        let lines = vec![
            "› Reply exactly ORCA-PASS.".into(),
            "• Working (0s • esc to interrupt) WorkingWorking".into(),
            "• ORCA-PASS  › Ask Codex to do anything".into(),
        ];
        assert_eq!(
            extract_final_agent_message(&lines).as_deref(),
            Some("ORCA-PASS")
        );
    }
}
