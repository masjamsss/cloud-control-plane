package edit

import (
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// setAssociationAttribute (spec) is mechanically identical to a scalar
// set_attribute — the value is an ARN/id association. The forcesReplace fail-safe
// (REFUSE FORCES_REPLACE) is enforced by the pipeline before any file is opened
// (spec); the truth of that label is re-checked later by plan-check.
func setAssociationAttribute(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	return setAttribute(op, req, loc)
}
