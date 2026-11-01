//! Cross-language contract test: the shared JSON fixtures in `shared/contracts/fixtures`
//! must round-trip through the Rust types and pass semantic validation, and the invalid
//! fixtures must be rejected. The same fixtures are validated by AJV in
//! `shared/contracts/tests`, so Rust and JavaScript stay in agreement.

use dp_core::contract::ActivityEvent;
use serde_json::Value;

const VALID: &[(&str, &str)] = &[
    (
        "app-session",
        include_str!("../../../../shared/contracts/fixtures/valid/app-session.json"),
    ),
    (
        "web-session",
        include_str!("../../../../shared/contracts/fixtures/valid/web-session.json"),
    ),
    (
        "idle-session",
        include_str!("../../../../shared/contracts/fixtures/valid/idle-session.json"),
    ),
];

const INVALID: &str = include_str!("../../../../shared/contracts/fixtures/invalid/events.json");
const SCHEMA: &str =
    include_str!("../../../../shared/contracts/schemas/activity-event.v1.schema.json");

#[test]
fn valid_fixtures_round_trip_exactly() {
    for (name, raw) in VALID {
        let original: Value = serde_json::from_str(raw).expect("fixture is JSON");
        let event: ActivityEvent =
            serde_json::from_str(raw).unwrap_or_else(|e| panic!("{name}: deserialize: {e}"));
        event
            .validate()
            .unwrap_or_else(|e| panic!("{name}: validate: {e}"));

        let reserialized = serde_json::to_value(&event).expect("serializable");
        let (Value::Object(a), Value::Object(b)) = (&original, &reserialized) else {
            panic!("{name}: expected objects");
        };
        let mut keys_a: Vec<_> = a.keys().collect();
        let mut keys_b: Vec<_> = b.keys().collect();
        keys_a.sort();
        keys_b.sort();
        assert_eq!(keys_a, keys_b, "{name}: key sets differ");
        for key in [
            "startedAt",
            "endedAt",
            "eventId",
            "deviceId",
            "type",
            "source",
        ] {
            assert_eq!(a[key], b[key], "{name}: field {key} differs");
        }
        assert_eq!(
            a["durationSeconds"].as_f64(),
            b["durationSeconds"].as_f64(),
            "{name}: duration differs"
        );
    }
}

#[test]
fn invalid_fixtures_are_rejected() {
    let cases: Vec<Value> = serde_json::from_str(INVALID).expect("invalid fixtures are JSON");
    assert!(!cases.is_empty());
    for case in cases {
        let reason = case["reason"].as_str().unwrap_or("?");
        let rejected = match serde_json::from_value::<ActivityEvent>(case["event"].clone()) {
            Err(_) => true,
            Ok(event) => event.validate().is_err(),
        };
        assert!(rejected, "fixture should be rejected: {reason}");
    }
}

#[test]
fn rust_required_fields_match_schema() {
    let schema: Value = serde_json::from_str(SCHEMA).expect("schema is JSON");
    let mut required: Vec<String> = schema["required"]
        .as_array()
        .expect("required array")
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    required.sort();

    let (_, raw) = VALID
        .iter()
        .find(|(n, _)| *n == "idle-session")
        .expect("idle fixture");
    let event: ActivityEvent = serde_json::from_str(raw).expect("deserialize");
    let Value::Object(map) = serde_json::to_value(event).expect("serialize") else {
        panic!("expected object");
    };
    let mut emitted: Vec<String> = map.keys().cloned().collect();
    emitted.sort();
    assert_eq!(
        emitted, required,
        "idle event must emit exactly the required fields"
    );
}
