use jsonschema::validator_for;
use serde_json::Value;

#[test]
fn example_snapshot_matches_contract() {
    let schema: Value =
        serde_json::from_str(include_str!("../../contracts/snapshot.schema.json")).unwrap();
    let example: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/snapshot.example.json"
    ))
    .unwrap();
    let validator = validator_for(&schema).unwrap();
    let result = validator.validate(&example);
    assert!(result.is_ok(), "example snapshot should match schema");
}
