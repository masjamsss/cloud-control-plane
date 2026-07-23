# DRAFT — generated from request REQ-AZ; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Enforce versus audit is the blocking-versus-advisory decision: Default denies non-compliant changes across the whole subscription, DoNotEnforce only reports them — confirm which you intend.
# TODO: A subscription assignment's blast radius is every resource in the subscription; confirm the policy has been tested in audit mode before it enforces.
# TODO: The subscription is the one set at onboarding — the engineer confirms the assignment targets the right subscription.

resource "azurerm_subscription_policy_assignment" "require_owner_tag_sub" {
  # TODO: subscription_id — engineer decides
  name = "require-owner-tag-sub"
  policy_definition_id = azurerm_policy_definition.require_owner_tag.id
  enforcement_mode = "DoNotEnforce"
  description = "Audit the Owner-tag policy across the subscription"
}
