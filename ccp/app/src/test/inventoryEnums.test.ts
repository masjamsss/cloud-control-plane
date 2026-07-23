import { describe, expect, it } from 'vitest';
import inventoryData from '@/data/inventory.json';
import { manifests } from '@/data/manifests';
import { parseInventoryEnum, resolveEnum } from '@/lib/interpreter';
import type { Inventory, ManifestOperation, ManifestParam } from '@/types';

/**
 * inventory-enum-resolves lint (0034 W3) — a picker must never be empty for a
 * reason the data can't explain.
 *
 * The defect class this makes mechanical: `rds-change-subnet-group-subnets`
 * shipped `inventory://aws_subnet/id` while the committed inventory carries
 * no `id` attribute on any of its 46 subnets — the picker rendered zero
 * options, so a required field could never be filled and the op was
 * un-submittable as authored. The same dead `/id` pattern sat on the three
 * mount-target security-group params, and the same mis-pointing (enumSource
 * naming the attribute to READ instead of the /address picker the
 * role:"reference" convention expects) sat on every kms/iam-role/sns-topic
 * reference param.
 *
 * Rule: every `inventory://<type>/<attr>` enum must resolve to at least one
 * row against the committed inventory — with ONE sanctioned exception class:
 * a type the estate legitimately has zero of (AWS Backup before adoption,
 * autoscaling, WAF…). Those are dormant-coverage ops (the 0031 growth
 * reserve), their emptiness is the estate's fact, and each type is declared
 * below WITH its reason. A stale-entry guard fails the moment the estate
 * adopts a listed type, so the table can only ever shrink honestly — and an
 * empty enum on a type the estate DOES run can never ship again.
 */

const inventory = inventoryData as unknown as Inventory;

/** Types the estate legitimately runs ZERO of today. An enum over one of
 * these resolves empty because the ESTATE is empty, not because the enum is
 * mis-authored. Every entry carries its reason; the stale guard below
 * removes entries the moment they stop being true. */
const EMPTY_TYPES: Record<string, string> = {
  aws_autoscaling_group: 'no auto-scaling estate today — dormant coverage (growth reserve)',
  aws_autoscaling_policy: 'no auto-scaling estate today — dormant coverage (growth reserve)',
  aws_backup_plan: 'zero AWS Backup estate — the create-a-plan baseline is the adoption path',
  aws_backup_selection: 'zero AWS Backup estate — selections follow the first plan',
  aws_backup_vault: 'zero AWS Backup estate — the create-a-vault baseline is the adoption path',
  aws_cloudtrail: 'no CloudTrail in the sample estate today — dormant coverage (growth reserve)',
  aws_cloudwatch_dashboard:
    'no CloudWatch dashboards in the sample estate today — dormant coverage (growth reserve)',
  aws_cloudwatch_event_rule:
    'no EventBridge estate in the sample today — dormant coverage (growth reserve)',
  aws_cloudwatch_event_target:
    'targets follow the first EventBridge rule — dormant coverage (growth reserve)',
  aws_cognito_user_pool: 'no Cognito estate today — cognito-pool-create is the adoption path',
  aws_config_config_rule: 'no AWS Config rules managed in Terraform today',
  aws_config_configuration_recorder:
    'no AWS Config estate in the sample today — dormant coverage (growth reserve)',
  aws_config_delivery_channel:
    'no AWS Config estate in the sample today — dormant coverage (growth reserve)',
  aws_db_snapshot:
    'manual DB snapshots are created via the snapshot op and pruned outside Terraform',
  aws_default_network_acl:
    'the sample’s synthetic VPC carries no explicit default-network-ACL resource — dormant coverage',
  aws_directory_service_directory:
    'no Directory Service estate today — directory-service-provision-directory is the adoption path; fsx-windows-create and connect-instance-create treat the AD picker as optional so an empty list never blocks the form',
  aws_dlm_lifecycle_policy:
    'no DLM estate in the sample today — dormant coverage (growth reserve)',
  aws_ec2_transit_gateway:
    'no transit gateway in the estate today — the create-a-transit-gateway baseline is the adoption path',
  aws_efs_backup_policy: 'no EFS backup policies materialized yet — created by the enable action',
  aws_efs_mount_target:
    'zero mount targets in the sample estate — the add-a-mount-target op creates the first',
  aws_iam_access_key: 'no IAM access keys managed in Terraform (deliberately)',
  aws_iam_group: 'no IAM groups in the sample estate today — dormant coverage (growth reserve)',
  aws_iam_role_policy:
    'the sample’s IAM role carries only a managed-policy attachment, no inline policy — dormant coverage',
  aws_lb_listener_rule:
    'the sample’s ALB listener carries no listener rules yet — dormant coverage (growth reserve)',
  aws_licensemanager_association: 'no license-manager associations in the estate today',
  aws_licensemanager_license_configuration:
    'no License Manager estate in the sample today — dormant coverage (growth reserve)',
  aws_network_acl:
    'the sample’s synthetic VPC carries no custom network ACL — dormant coverage (growth reserve)',
  aws_network_interface: 'no standalone network interfaces managed in Terraform today',
  aws_route:
    'routes are authored inline on route tables in this estate, not as aws_route resources',
  aws_route53_record: 'no Route 53 estate in this account today',
  aws_route53_zone: 'no Route 53 estate in this account today',
  aws_route_table_association: 'associations exist in AWS but are not yet adopted into Terraform',
  aws_s3_bucket_lifecycle_configuration:
    'the sample’s buckets carry no lifecycle configuration yet — dormant coverage (growth reserve)',
  aws_s3_bucket_public_access_block:
    'the sample’s buckets carry no public-access-block configuration yet — dormant coverage',
  aws_sagemaker_domain: 'no SageMaker estate in the sample today — dormant coverage (growth reserve)',
  aws_sagemaker_user_profile: 'profiles follow the first SageMaker domain — dormant coverage (growth reserve)',
  aws_secretsmanager_secret: 'no secrets managed in Terraform today',
  aws_secretsmanager_secret_rotation: 'no secret rotations managed in Terraform today',
  aws_sns_topic_subscription:
    'subscriptions are console-managed today; the add op creates the first',
  aws_sqs_queue: 'no SQS estate in this account today',
  aws_vpn_connection_route: 'route resources are the vpn baseline’s adoption path — zero exist yet',
  aws_wafv2_ip_set: 'no WAF estate managed in Terraform today',
  // ── 0039 comprehensive tag foundation — the auto-wired family-manifest tag
  // ops cover the long tail of taggable aws types the estate does not run in
  // Terraform today; each resolves an empty picker because the ESTATE is empty
  // of that type, not because the enum is mis-authored (same dormant-coverage
  // class as the curated aws types above and the azure block below — the
  // stale-guard still fails the moment the estate adopts any of them).
  aws_alb:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_alb_listener:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_alb_target_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ami:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ami_copy:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ami_from_instance:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_amplify_app:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_amplify_branch:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_api_gateway_api_key:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_api_gateway_domain_name:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_api_gateway_rest_api:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_api_gateway_stage:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_api_gateway_usage_plan:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_api_gateway_vpc_link:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_apigatewayv2_api:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_apigatewayv2_domain_name:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_apigatewayv2_stage:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_apigatewayv2_vpc_link:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appautoscaling_target:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appconfig_application:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appconfig_configuration_profile:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appconfig_deployment:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appconfig_deployment_strategy:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appconfig_extension:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appflow_flow:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appintegrations_data_integration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appintegrations_event_integration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_applicationinsights_application:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appmesh_mesh:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appmesh_virtual_gateway:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appmesh_virtual_node:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appmesh_virtual_router:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appmesh_virtual_service:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_apprunner_auto_scaling_configuration_version:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_apprunner_connection:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_apprunner_observability_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_apprunner_service:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_apprunner_vpc_connector:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_apprunner_vpc_ingress_connection:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appstream_fleet:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appstream_image_builder:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appstream_stack:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_appsync_graphql_api:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_athena_data_catalog:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_athena_workgroup:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_backup_framework:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_backup_report_plan:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_batch_compute_environment:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_batch_job_definition:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_budgets_budget:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_budgets_budget_action:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ce_anomaly_monitor:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ce_anomaly_subscription:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ce_cost_category:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_chime_voice_connector:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_chimesdkmediapipelines_media_insights_pipeline_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_chimesdkvoice_sip_media_application:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_chimesdkvoice_voice_profile_domain:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_cleanrooms_collaboration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_cleanrooms_configured_table:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_cloud9_environment_ec2:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_cloudformation_stack:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_cloudformation_stack_set:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_cloudfront_function:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_cloudwatch_composite_alarm:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_cloudwatch_event_bus:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_cloudwatch_log_destination:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_cloudwatch_metric_stream:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codeartifact_domain:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codeartifact_repository:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codebuild_fleet:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codebuild_project:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codebuild_report_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codecommit_repository:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codedeploy_app:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codedeploy_deployment_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codepipeline:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codepipeline_custom_action_type:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codepipeline_webhook:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_codestarconnections_connection:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_comprehend_document_classifier:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_comprehend_entity_recognizer:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_contact_flow:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_contact_flow_module:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_hours_of_operation:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_instance:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_phone_number:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_queue:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_quick_connect:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_routing_profile:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_security_profile:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_user:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_user_hierarchy_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_connect_vocabulary:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_cur_report_definition:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_customerprofiles_domain:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_dataexchange_data_set:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_dataexchange_revision:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datapipeline_pipeline:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_agent:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_location_azure_blob:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_location_efs:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_location_fsx_lustre_file_system:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_location_fsx_ontap_file_system:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_location_fsx_openzfs_file_system:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_location_fsx_windows_file_system:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_location_hdfs:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_location_nfs:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_location_object_storage:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_location_s3:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_location_smb:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_datasync_task:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_dax_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_db_cluster_snapshot:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_db_event_subscription:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_db_option_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_db_parameter_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_db_proxy:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_db_proxy_endpoint:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_db_snapshot_copy:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_default_subnet:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_default_vpc:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_devicefarm_device_pool:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_devicefarm_instance_profile:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_devicefarm_network_profile:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_devicefarm_project:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_devicefarm_test_grid_project:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_dms_endpoint:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_dms_event_subscription:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_dms_replication_config:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_dms_replication_instance:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_dms_replication_subnet_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_dms_replication_task:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_dms_s3_endpoint:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_docdb_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_docdb_cluster_instance:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_docdb_cluster_parameter_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_docdb_event_subscription:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_docdb_subnet_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_dynamodb_table_replica:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ebs_snapshot:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ebs_snapshot_copy:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ebs_snapshot_import:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ec2_capacity_reservation:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ec2_fleet:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ec2_host:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ecr_repository:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ecrpublic_repository:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ecs_capacity_provider:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ecs_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ecs_service:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ecs_task_definition:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ecs_task_set:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_efs_access_point:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_eks_access_entry:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_eks_addon:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_eks_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_eks_fargate_profile:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_eks_identity_provider_config:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_eks_node_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_elastic_beanstalk_application:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_elastic_beanstalk_application_version:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_elastic_beanstalk_environment:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_elasticache_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_elasticache_parameter_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_elasticache_replication_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_elasticache_subnet_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_elasticache_user:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_elasticache_user_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_elasticsearch_domain:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_elb:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_emr_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_emr_studio:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_emrcontainers_virtual_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_emrserverless_application:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_evidently_feature:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_evidently_launch:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_evidently_project:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_evidently_segment:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_finspace_kx_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_finspace_kx_database:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_finspace_kx_dataview:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_finspace_kx_environment:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_finspace_kx_scaling_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_finspace_kx_user:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_finspace_kx_volume:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_fsx_backup:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_fsx_file_cache:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_fsx_lustre_file_system:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_fsx_ontap_file_system:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_fsx_ontap_storage_virtual_machine:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_fsx_ontap_volume:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_fsx_openzfs_file_system:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_fsx_openzfs_snapshot:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_fsx_openzfs_volume:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_fsx_windows_file_system:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_gamelift_alias:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_gamelift_build:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_gamelift_fleet:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_gamelift_game_server_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_gamelift_game_session_queue:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_gamelift_script:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glacier_vault:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_globalaccelerator_accelerator:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_globalaccelerator_custom_routing_accelerator:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glue_catalog_database:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glue_connection:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glue_crawler:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glue_data_quality_ruleset:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glue_dev_endpoint:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glue_job:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glue_ml_transform:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glue_registry:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glue_schema:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glue_trigger:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_glue_workflow:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_grafana_workspace:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_imagebuilder_component:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_imagebuilder_container_recipe:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_imagebuilder_distribution_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_imagebuilder_image:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_imagebuilder_image_pipeline:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_imagebuilder_image_recipe:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_imagebuilder_infrastructure_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_imagebuilder_workflow:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_internetmonitor_monitor:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_iot_authorizer:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_iot_domain_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_iot_provisioning_template:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_iot_role_alias:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_iot_thing_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_iot_thing_type:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ivs_channel:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ivschat_logging_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ivschat_room:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_kendra_data_source:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_kendra_faq:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_kendra_index:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_kendra_query_suggestions_block_list:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_kendra_thesaurus:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_keyspaces_keyspace:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_keyspaces_table:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_kinesis_analytics_application:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_kinesis_firehose_delivery_stream:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_kinesis_stream:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_kinesis_stream_consumer:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_kinesis_video_stream:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_kinesisanalyticsv2_application:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_lambda_code_signing_config:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_lambda_event_source_mapping:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_launch_template:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_lb_trust_store:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_lightsail_bucket:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_lightsail_container_service:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_lightsail_database:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_lightsail_disk:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_lightsail_distribution:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_lightsail_instance:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_lightsail_key_pair:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_lightsail_lb:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_location_geofence_collection:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_location_map:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_location_place_index:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_location_route_calculator:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_location_tracker:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_media_convert_queue:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_media_package_channel:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_media_store_container:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_medialive_channel:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_medialive_input:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_medialive_multiplex:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_memorydb_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_memorydb_parameter_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_memorydb_snapshot:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_memorydb_subnet_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_memorydb_user:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_mq_broker:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_mq_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_msk_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_msk_replicator:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_msk_serverless_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_msk_vpc_connection:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_mskconnect_connector:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_mskconnect_custom_plugin:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_mskconnect_worker_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_mwaa_environment:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_neptune_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_neptune_cluster_endpoint:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_neptune_cluster_instance:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_neptune_cluster_parameter_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_neptune_event_subscription:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_neptune_parameter_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_neptune_subnet_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_oam_link:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_oam_sink:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_opensearch_domain:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_pinpoint_app:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_pipes_pipe:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_placement_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_prometheus_workspace:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_qldb_ledger:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_qldb_stream:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_quicksight_analysis:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_quicksight_dashboard:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_quicksight_data_set:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_quicksight_data_source:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_quicksight_folder:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_quicksight_template:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_quicksight_theme:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_rds_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_rds_cluster_endpoint:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_rds_cluster_instance:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_rds_cluster_parameter_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_rds_custom_db_engine_version:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_rds_global_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_rds_reserved_instance:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_redshift_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_redshift_cluster_snapshot:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_redshift_event_subscription:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_redshift_hsm_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_redshift_parameter_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_redshift_snapshot_schedule:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_redshift_subnet_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_redshift_usage_limit:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_redshiftserverless_namespace:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_redshiftserverless_workgroup:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_resourcegroups_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_route53_health_check:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_route53_resolver_endpoint:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_route53_resolver_firewall_domain_list:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_route53_resolver_query_log_config:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_route53domains_registered_domain:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_route53recoverycontrolconfig_cluster:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_route53recoverycontrolconfig_control_panel:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_route53recoveryreadiness_cell:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_route53recoveryreadiness_readiness_check:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_route53recoveryreadiness_recovery_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_route53recoveryreadiness_resource_set:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_rum_app_monitor:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_s3_access_point:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_s3_bucket_object:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_s3_object:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_s3_object_copy:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_s3control_bucket:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_s3control_storage_lens_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_app:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_app_image_config:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_code_repository:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_data_quality_job_definition:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_device_fleet:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_endpoint:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_endpoint_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_feature_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_flow_definition:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_hub:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_human_task_ui:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_image:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_mlflow_tracking_server:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_model:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_model_package_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_monitoring_schedule:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_notebook_instance:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_notebook_instance_lifecycle_configuration:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_project:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_space:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_studio_lifecycle_config:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sagemaker_workteam:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_scheduler_schedule_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_schemas_discoverer:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_schemas_registry:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_schemas_schema:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_serverlessapplicationrepository_cloudformation_stack:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_service_discovery_http_namespace:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_service_discovery_private_dns_namespace:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_service_discovery_public_dns_namespace:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_service_discovery_service:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_servicecatalog_portfolio:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_servicecatalog_product:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_servicecatalog_provisioned_product:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sesv2_configuration_set:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sesv2_contact_list:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sesv2_dedicated_ip_pool:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sesv2_email_identity:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sfn_activity:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_sfn_state_machine:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_spot_fleet_request:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_spot_instance_request:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ssm_document:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ssm_maintenance_window:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ssmcontacts_contact:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ssmincidents_replication_set:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_ssmincidents_response_plan:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_storagegateway_cached_iscsi_volume:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_storagegateway_gateway:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_storagegateway_nfs_file_share:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_storagegateway_smb_file_share:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_storagegateway_stored_iscsi_volume:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_storagegateway_tape_pool:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_swf_domain:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_synthetics_canary:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_synthetics_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_timestreamwrite_database:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_timestreamwrite_table:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_transcribe_language_model:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_transcribe_medical_vocabulary:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_transcribe_vocabulary:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_transcribe_vocabulary_filter:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_transfer_agreement:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_transfer_connector:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_transfer_profile:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_transfer_server:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_transfer_user:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_transfer_workflow:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_vpclattice_access_log_subscription:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_vpclattice_listener:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_vpclattice_service:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_vpclattice_service_network:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_vpclattice_target_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_workspaces_directory:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_workspaces_ip_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_workspaces_workspace:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  aws_xray_group:
    'estate runs zero of this type today — auto-wired tag coverage, dormant until adopted (0039 comprehensive foundation)',
  azurerm_aadb2c_directory: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_active_directory_domain_service:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_ai_foundry: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_ai_foundry_project: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_ai_services: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_analysis_services_server:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_api_connection: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_api_management: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_app_configuration: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_app_configuration_feature:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_app_service: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_app_service_certificate:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_app_service_certificate_order:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_app_service_environment_v3:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_app_service_managed_certificate:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_app_service_plan: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_app_service_slot: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_application_insights:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_application_insights_standard_web_test:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_application_insights_web_test:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_application_insights_workbook:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_application_insights_workbook_template:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_application_load_balancer:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_application_load_balancer_frontend:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_application_load_balancer_subnet_association:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_arc_kubernetes_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_arc_kubernetes_provisioned_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_arc_machine: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_arc_machine_extension:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_arc_resource_bridge_appliance:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_attestation_provider:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_automanage_configuration:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_automation_account: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_automation_dsc_configuration:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_automation_powershell72_module:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_automation_python3_package:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_automation_runbook: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_automation_watcher: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_availability_set: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_bastion_host: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_batch_account: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_bot_channels_registration:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_bot_service_azure_bot:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_bot_web_app: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_capacity_reservation:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_capacity_reservation_group:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_cdn_endpoint: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_cdn_frontdoor_endpoint:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_cdn_frontdoor_profile:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_cdn_profile: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_cognitive_account: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_cognitive_account_project:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_communication_service:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_confidential_ledger:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_container_app: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_container_app_environment:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_container_app_environment_certificate:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_container_app_environment_managed_certificate:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_container_app_job: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_container_group: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_container_registry: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_container_registry_agent_pool:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_container_registry_task:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_container_registry_webhook:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_cosmosdb_account: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_cosmosdb_cassandra_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_cosmosdb_postgresql_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_custom_ip_prefix: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dashboard_grafana: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_data_factory: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_data_protection_backup_vault:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_data_protection_resource_guard:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_data_share_account: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_database_migration_project:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_database_migration_service:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_databox_edge_device:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_databricks_access_connector:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_databricks_workspace:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_datadog_monitor: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dedicated_hardware_security_module:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dedicated_host: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dedicated_host_group:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_center: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_center_dev_box_definition:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_center_environment_type:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_center_network_connection:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_center_project: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_center_project_environment_type:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_center_project_pool:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_test_global_vm_shutdown_schedule:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_test_lab: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_test_linux_virtual_machine:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_test_schedule: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_test_virtual_network:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dev_test_windows_virtual_machine:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_digital_twins_instance:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_disk_access: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_disk_encryption_set:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dns_a_record: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dns_aaaa_record: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dns_caa_record: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dns_cname_record: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dns_mx_record: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dns_ns_record: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dns_ptr_record: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dns_srv_record: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dns_txt_record: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dns_zone: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_dynatrace_monitor: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_elastic_cloud_elasticsearch:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_elastic_san: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_email_communication_service:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_email_communication_service_domain:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_eventgrid_domain: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_eventgrid_namespace:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_eventgrid_partner_configuration:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_eventgrid_partner_namespace:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_eventgrid_partner_registration:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_eventgrid_system_topic:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_eventgrid_topic: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_eventhub_cluster: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_eventhub_namespace: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_eventhub_namespace_authorization_rule:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_fabric_capacity: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_firewall: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_fluid_relay_server: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_frontdoor: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_function_app: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_function_app_flex_consumption:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_function_app_slot: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_gallery_application:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_gallery_application_version:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_graph_services_account:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_hdinsight_hadoop_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_hdinsight_hbase_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_hdinsight_interactive_query_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_hdinsight_kafka_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_hdinsight_spark_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_healthbot: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_healthcare_dicom_service:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_healthcare_fhir_service:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_healthcare_medtech_service:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_healthcare_service: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_healthcare_workspace:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_hpc_cache: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_image: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_iot_security_solution:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_iotcentral_application:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_iothub: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_iothub_device_update_account:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_iothub_device_update_instance:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_iothub_dps: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_ip_group: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_key_vault: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_kubernetes_automatic_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_kubernetes_cluster: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_kubernetes_cluster_node_pool:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_kubernetes_fleet_manager:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_kusto_cluster: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_lb: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_linux_function_app: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_linux_function_app_slot:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_linux_virtual_machine:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_linux_virtual_machine_scale_set:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_linux_web_app: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_linux_web_app_slot: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_load_test: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_log_analytics_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_log_analytics_query_pack:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_log_analytics_query_pack_query:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_log_analytics_solution:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_log_analytics_workspace:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_logic_app_integration_account:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_logic_app_standard: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_logic_app_workflow: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_machine_learning_compute_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_machine_learning_workspace:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_maintenance_configuration:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_managed_application:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_managed_application_definition:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_managed_devops_pool:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_managed_disk: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_managed_lustre_file_system:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_managed_redis: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_management_group: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_maps_account: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_maps_creator: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_mongo_cluster: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_monitor_action_group:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_monitor_activity_log_alert:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_monitor_autoscale_setting:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_monitor_data_collection_endpoint:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_monitor_metric_alert:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_monitor_workspace: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_mssql_database: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_mssql_elasticpool: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_mssql_failover_group:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_mssql_job_agent: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_mssql_managed_database:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_mssql_managed_instance:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_mssql_server: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_mssql_virtual_machine:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_mssql_virtual_machine_group:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_mysql_flexible_server:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_netapp_account: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_netapp_backup_vault:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_netapp_pool: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_netapp_volume: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_network_connection_monitor:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_network_ddos_protection_plan:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_network_function_azure_traffic_collector:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_network_interface: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_network_profile: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_network_security_group:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_nginx_deployment: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_notification_hub: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_notification_hub_namespace:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_oracle_autonomous_database:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_oracle_cloud_vm_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_oracle_exadata_infrastructure:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_oracle_exascale_database_storage_vault:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_oracle_resource_anchor:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_orbital_contact_profile:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_orbital_spacecraft: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_orchestrated_virtual_machine_scale_set:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_policy_definition: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_portal_dashboard: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_postgresql_flexible_server:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_postgresql_server: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_powerbi_embedded: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_a_record:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_aaaa_record:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_cname_record:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_mx_record:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_ptr_record:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_resolver:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_resolver_inbound_endpoint:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_resolver_outbound_endpoint:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_srv_record:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_txt_record:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_zone: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_private_dns_zone_virtual_network_link:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_proximity_placement_group:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_public_ip: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_public_ip_prefix: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_purview_account: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_qumulo_file_system: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_recovery_services_vault:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_redhat_openshift_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_redis_cache: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_redis_enterprise_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_relay_namespace: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_resource_deployment_script_azure_cli:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_resource_deployment_script_azure_power_shell:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_resource_group: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_resource_group_template_deployment:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_restore_point_collection:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_search_service: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_service_fabric_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_service_fabric_managed_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_service_plan: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_servicebus_namespace:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_shared_image: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_shared_image_gallery:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_shared_image_version:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_signalr_service: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_snapshot: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_spring_cloud_service:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_stack_hci_cluster: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_stack_hci_logical_network:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_stack_hci_marketplace_gallery_image:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_stack_hci_network_interface:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_stack_hci_storage_path:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_stack_hci_virtual_hard_disk:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_static_site: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_static_web_app: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_storage_account: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_storage_container: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_subnet: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_storage_mover: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_storage_share: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_storage_sync: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_stream_analytics_cluster:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_stream_analytics_job:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_subscription: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_subscription_template_deployment:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_synapse_spark_pool: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_synapse_sql_pool: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_synapse_workspace: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_system_center_virtual_machine_manager_availability_set:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_system_center_virtual_machine_manager_cloud:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_system_center_virtual_machine_manager_server:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_system_center_virtual_machine_manager_virtual_machine_template:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_system_center_virtual_machine_manager_virtual_network:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_tenant_template_deployment:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_traffic_manager_profile:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_trusted_signing_account:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_user_assigned_identity:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_video_indexer_account:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_desktop_application_group:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_desktop_host_pool:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_desktop_scaling_plan:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_desktop_workspace:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_hub: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_hub_security_partner_provider:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_machine: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_machine_extension:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_machine_restore_point_collection:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_machine_run_command:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_machine_scale_set:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_machine_scale_set_standby_pool:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_network: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_virtual_network_gateway:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_vmware_private_cloud:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_web_pubsub: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_web_pubsub_socketio:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_windows_function_app:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_windows_function_app_slot:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_windows_virtual_machine:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_windows_virtual_machine_scale_set:
    'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_windows_web_app: 'no Azure estate imported yet — Azure estate-import is a later phase',
  azurerm_windows_web_app_slot:
    'no Azure estate imported yet — Azure estate-import is a later phase',
};

interface EnumUse {
  opId: string;
  param: ManifestParam;
  type: string;
  field: string;
  rows: number;
  typeRows: number;
}

function collectEnumUses(): EnumUse[] {
  const typeCounts = new Map<string, number>();
  for (const r of inventory.resources) {
    typeCounts.set(r.resourceType, (typeCounts.get(r.resourceType) ?? 0) + 1);
  }
  const uses: EnumUse[] = [];
  const ops: ManifestOperation[] = manifests.flatMap((m) => m.operations);
  for (const op of ops) {
    for (const p of op.params) {
      const src = parseInventoryEnum(p.enumSource);
      if (!src) continue;
      uses.push({
        opId: op.id,
        param: p,
        type: src.type,
        field: src.field,
        rows: resolveEnum(p, inventory).length,
        typeRows: typeCounts.get(src.type) ?? 0,
      });
    }
  }
  return uses;
}

const uses = collectEnumUses();

describe('inventory-enum-resolves (0034 W3) — every picker fills or its emptiness is the estate’s', () => {
  it('audits a real slice of the catalog (sanity)', () => {
    expect(uses.length).toBeGreaterThan(300);
  });

  it('no enum resolves to zero rows on a type the estate runs (the dead-end class)', () => {
    const offenders = uses
      .filter((u) => u.rows === 0 && u.typeRows > 0)
      .map(
        (u) =>
          `${u.opId} · ${u.param.name} → ${u.param.enumSource} (type has ${u.typeRows} rows; attribute resolves 0)`,
      );
    expect(offenders, `dead-end enums:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every zero-row enum sits on a declared legitimately-empty type', () => {
    const offenders = uses
      .filter((u) => u.rows === 0 && !(u.type in EMPTY_TYPES))
      .map((u) => `${u.opId} · ${u.param.name} → ${u.param.enumSource}`);
    expect(offenders, `empty enums on undeclared types:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every declared empty type is still empty AND still referenced (no stale entries)', () => {
    const typeCounts = new Map<string, number>();
    for (const r of inventory.resources) {
      typeCounts.set(r.resourceType, (typeCounts.get(r.resourceType) ?? 0) + 1);
    }
    const referenced = new Set(uses.map((u) => u.type));
    const stale: string[] = [];
    for (const t of Object.keys(EMPTY_TYPES)) {
      if ((typeCounts.get(t) ?? 0) > 0) {
        stale.push(`${t}: the estate now runs ${typeCounts.get(t)} — remove the entry`);
      }
      if (!referenced.has(t)) {
        stale.push(`${t}: no enum references it any more — remove the entry`);
      }
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('the four named dead-ends are re-pointed and resolve (0034 W3 acceptance)', () => {
    // The historical bug was the enumSource pointing at the wrong attribute
    // (…/id instead of …/address), not any particular row count — the
    // acceptance criterion is "points at /address AND resolves at least one
    // row", which holds regardless of how large the active estate is.
    const byKey = new Map<string, EnumUse>(uses.map((u) => [`${u.opId}/${u.param.name}`, u]));
    const subnetIds = byKey.get('rds-change-subnet-group-subnets/subnet_ids')!;
    expect(subnetIds.param.enumSource).toBe('inventory://aws_subnet/address');
    expect(subnetIds.rows).toBeGreaterThan(0);
    for (const key of [
      'efs-mt-update-security-groups/security_groups',
      'efs-mt-add-security-group/security_group',
      'efs-mt-remove-security-group/security_group',
    ]) {
      const u = byKey.get(key)!;
      expect(u.param.enumSource, key).toBe('inventory://aws_security_group/address');
      expect(u.rows, key).toBeGreaterThan(0);
    }
  });

  it('reference params pick addresses, never the attribute they read (the convention itself)', () => {
    // A role:"reference" param resolves the picked ADDRESS to `<addr>.<refAttr>`;
    // an enumSource pointing at the attribute (…/arn) hands the executor a
    // value it can never locate. With the W3 re-points the whole catalog obeys.
    const offenders = uses
      .filter((u) => u.param.role === 'reference' && u.field !== 'address')
      .map((u) => `${u.opId} · ${u.param.name} → ${u.param.enumSource}`);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
