# schemadump vs forcenew-map.json — comparison

Generated from `aws-v6.53.0-schema.json` (provider hashicorp/aws 6.53.0, commit `a0c8167ac1f9d8e20925e2084f56ce1d65a50a40`).

**The dump is the authority.** `forcenew-map.json` was built by a grep/AST scan of provider source that left ~349 nested attributes `unresolved`; the compile-and-reflect dump resolves ForceNew from the live SDKv2 schema tree. Where they disagree, the dump wins and the row is flagged for review. This file is advisory input to the wiring step (a separate reviewed PR); `forcenew-map.json` is NOT modified here.

## Headline

| Category | Count |
|---|---|
| forcenew-map.json keys | 489 |
| agree (both resolved, same verdict) | 128 |
| **disagree** (both resolved, opposite verdict) | **0** |
| **newly-resolved** (map=unresolved -> dump resolves) | **267** |
| still-unresolved (map=unresolved, dump path not found) | 80 |
| path-unresolved (map=resolved, dump path not found) | 9 |
| type-out-of-scope (type not in the 85) | 0 |
| framework (unreflected) | 5 |

Of the 267 newly-resolved (the WARN class 0013d L1 targets): **9 force_new**, **258 in_place**.

## Ground-truth checks

| Attribute | Expect force_new | Got | Result |
|---|---|---|---|
| `aws_instance.instance_type` | False | found/False | PASS — resize in place |
| `aws_instance.availability_zone` | True | found/True | PASS — moving AZ replaces |
| `aws_ebs_volume.size` | False | found/False | PASS — grow in place |
| `aws_db_instance.engine` | True | found/True | PASS — engine change replaces |

Three checks drawn from forcenew-map.json (map verdict vs dump verdict):

| Attribute | forcenew-map | dump | Result |
|---|---|---|---|
| `aws_instance.associate_public_ip_address` | force_new | force_new | AGREE |
| `aws_acm_certificate.early_renewal_duration` | in_place | in_place | AGREE |
| `aws_acm_certificate.options.certificate_transparency_logging_preference` | in_place | in_place | AGREE |

## Disagreements

None — every key resolved by BOTH sources agrees.

## Path-unresolved (map had a verdict; dump nesting differs)

These keys carry a resolved verdict in forcenew-map.json but their dotted path does not resolve against the reflected nesting — the B1 defect class: the map key was recorded with the block levels flattened away. The dump's full path (searched by leaf attribute name) is proposed below; the wiring step should re-key these. None are silently dropped.

| Map key | forcenew-map | Dump full path (proposed) | Dump force_new |
|---|---|---|---|
| `aws_autoscaling_policy.disable_scale_in` | in_place | `aws_autoscaling_policy.target_tracking_configuration.disable_scale_in` | in_place |
| `aws_backup_plan.rule_name` | in_place | `aws_backup_plan.rule.rule_name` | in_place |
| `aws_cloudwatch_event_target.maximum_event_age_in_seconds` | in_place | `aws_cloudwatch_event_target.retry_policy.maximum_event_age_in_seconds` | in_place |
| `aws_efs_file_system.transition_to_ia` | in_place | `aws_efs_file_system.lifecycle_policy.transition_to_ia` | in_place |
| `aws_instance.capacity_reservation_preference` | in_place | `aws_instance.capacity_reservation_specification.capacity_reservation_preference` | in_place |
| `aws_instance.spot_options.instance_interruption_behavior` | force_new | `aws_instance.instance_market_options.spot_options.instance_interruption_behavior` | force_new |
| `aws_instance.spot_options.valid_until` | force_new | `aws_instance.instance_market_options.spot_options.valid_until` | force_new |
| `aws_lb_target_group.healthy_threshold` | in_place | `aws_lb_target_group.health_check.healthy_threshold` | in_place |
| `aws_wafv2_web_acl.override_action` | in_place | `aws_wafv2_web_acl.rule.override_action` | in_place |

## Still-unresolved characterization (80 keys)

- **30 `.purpose` keys** — synthetic estate-level params (one per resource type), never provider attributes; correctly stay unresolved / fail-closed.
- **24 re-keyable at a deeper path** — same B1 class as above: the leaf exists in the reflected tree under a fuller block chain (note the `aws_dlm_lifecycle_policy.*` family, which is missing the `policy_details.` prefix — the exact B1 bug of 0013d §1). All resolve in_place at their full paths:

| Map key | Dump full path (proposed) | Dump force_new |
|---|---|---|
| `aws_cloudfront_distribution.compress` | `aws_cloudfront_distribution.default_cache_behavior.compress` (+1 more) | in_place |
| `aws_cloudfront_distribution.default_ttl` | `aws_cloudfront_distribution.default_cache_behavior.default_ttl` (+1 more) | in_place |
| `aws_cloudwatch_metric_alarm.pending_period` | `aws_cloudwatch_metric_alarm.evaluation_criteria.promql_criteria.pending_period` | in_place |
| `aws_cloudwatch_metric_alarm.recovery_period` | `aws_cloudwatch_metric_alarm.evaluation_criteria.promql_criteria.recovery_period` | in_place |
| `aws_config_delivery_channel.delivery_frequency` | `aws_config_delivery_channel.snapshot_delivery_properties.delivery_frequency` | in_place |
| `aws_dlm_lifecycle_policy.action.cross_region_copy.encryption_configuration.cmk_arn` | `aws_dlm_lifecycle_policy.policy_details.action.cross_region_copy.encryption_configuration.cmk_arn` | in_place |
| `aws_dlm_lifecycle_policy.action.cross_region_copy.encryption_configuration.encrypted` | `aws_dlm_lifecycle_policy.policy_details.action.cross_region_copy.encryption_configuration.encrypted` | in_place |
| `aws_dlm_lifecycle_policy.action.cross_region_copy.retain_rule.interval` | `aws_dlm_lifecycle_policy.policy_details.action.cross_region_copy.retain_rule.interval` | in_place |
| `aws_dlm_lifecycle_policy.cross_region_copy_rule.cmk_arn` | `aws_dlm_lifecycle_policy.policy_details.schedule.cross_region_copy_rule.cmk_arn` | in_place |
| `aws_dlm_lifecycle_policy.cross_region_copy_rule.encrypted` | `aws_dlm_lifecycle_policy.policy_details.schedule.cross_region_copy_rule.encrypted` | in_place |
| `aws_dlm_lifecycle_policy.cross_region_copy_rule.retain_rule.interval` | `aws_dlm_lifecycle_policy.policy_details.schedule.cross_region_copy_rule.retain_rule.interval` | in_place |
| `aws_dlm_lifecycle_policy.retention_archive_tier.count` | `aws_dlm_lifecycle_policy.policy_details.schedule.archive_rule.archive_retain_rule.retention_archive_tier.count` | in_place |
| `aws_dlm_lifecycle_policy.retention_archive_tier.interval` | `aws_dlm_lifecycle_policy.policy_details.schedule.archive_rule.archive_retain_rule.retention_archive_tier.interval` | in_place |
| `aws_dlm_lifecycle_policy.scripts.execute_operation_on_script_failure` | `aws_dlm_lifecycle_policy.policy_details.schedule.create_rule.scripts.execute_operation_on_script_failure` | in_place |
| `aws_dlm_lifecycle_policy.scripts.execution_handler` | `aws_dlm_lifecycle_policy.policy_details.schedule.create_rule.scripts.execution_handler` | in_place |
| `aws_dlm_lifecycle_policy.scripts.maximum_retry_count` | `aws_dlm_lifecycle_policy.policy_details.schedule.create_rule.scripts.maximum_retry_count` | in_place |
| `aws_dlm_lifecycle_policy.scripts.stages` | `aws_dlm_lifecycle_policy.policy_details.schedule.create_rule.scripts.stages` | in_place |
| `aws_route53_record.weight` | `aws_route53_record.weighted_routing_policy.weight` | in_place |
| `aws_s3_bucket_versioning.status` | `aws_s3_bucket_versioning.versioning_configuration.status` | in_place |
| `aws_sagemaker_domain.app_lifecycle_management.idle_settings` | `aws_sagemaker_domain.default_space_settings.jupyter_lab_app_settings.app_lifecycle_management.idle_settings` (+2 more) | in_place |
| `aws_secretsmanager_secret_rotation.automatically_after_days` | `aws_secretsmanager_secret_rotation.rotation_rules.automatically_after_days` | in_place |
| `aws_wafv2_web_acl.rate_based_statement.aggregate_key_type` | `aws_wafv2_web_acl.rule.statement.rate_based_statement.aggregate_key_type` | in_place |
| `aws_wafv2_web_acl.rate_based_statement.evaluation_window_sec` | `aws_wafv2_web_acl.rule.statement.rate_based_statement.evaluation_window_sec` | in_place |
| `aws_wafv2_web_acl.rate_based_statement.limit` | `aws_wafv2_web_acl.rule.statement.rate_based_statement.limit` | in_place |

- **26 with no leaf match** — synthetic/UI param keys (e.g. `tag_key`, `env_key`, `ttl_enabled`) or renamed attrs; they stay unresolved ⇒ fail-closed (treated AS ForceNew per the 0010 §3 rule):

  `aws_cloudfront_distribution.web_acl_arn`, `aws_dlm_lifecycle_policy.schedule_name`, `aws_dynamodb_table.point_in_time_recovery_enabled`, `aws_dynamodb_table.tag_key`, `aws_dynamodb_table.ttl_enabled`, `aws_ebs_volume.target_type`, `aws_efs_backup_policy.backup_policy_status`, `aws_efs_file_system.key`, `aws_eip.detach_target`, `aws_iam_role.tag_key`, `aws_lambda_function.env_key`, `aws_lambda_function.use_resource_timeout_for_propagation`, `aws_lb.idle_timeout_seconds`, `aws_lb_listener.in`, `aws_lb_listener_certificate.aws_lb_listener_certificate`, `aws_lb_target_group.flow_rebalancing`, `aws_licensemanager_license_configuration.hard_limit`, `aws_route_table.tag_key`, `aws_sagemaker_domain.app_type`, `aws_sagemaker_user_profile.app_type`, `aws_sns_topic.delivery_policy_num_retries`, `aws_sns_topic.policy_template`, `aws_ssm_parameter.value_reference`, `aws_subnet.tag_key`, `aws_vpn_connection.tunnel_number`, `aws_wafv2_web_acl.protected_resource_type`

## Structural cross-check vs `terraform providers schema -json`

The JSON schema (from the pinned provider binary) OMITS ForceNew (L1) but is an independent structural witness. Top-level attribute sets (protocol-synthesized `id`/`timeouts` excluded) compared for 84 SDKv2 types: **84 identical**.

## Summary census (from dump metadata)

- requested types: 85
- SDKv2-reflected: 84
- framework_unreflected: 1  ['aws_s3_bucket_lifecycle_configuration']
- missing: 0  
- attributes reflected (recursive): 22410 (force_new true=348, false=22062)
