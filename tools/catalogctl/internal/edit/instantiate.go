package edit

import (
	"fmt"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// instantiateModule (spec + frozen). If the proposed address already
// exists in --env → REFUSE ALREADY_EXISTS. Otherwise, until an overlay names a
// module source, every instantiate refuses NO_MODULE_SOURCE (v1 frozen answer).
// There is no accept path in v1.
func instantiateModule(op manifests.Op, req *request.Request, envDir string) (string, string) {
	name := instantiateName(op, req)
	address := "module." + name
	if _, _, code := hclops.Locate(envDir, address); code == 0 {
		return "ALREADY_EXISTS", fmt.Sprintf("%s already exists in the environment", address)
	}
	return "NO_MODULE_SOURCE", fmt.Sprintf("no module source is wired for %s (instantiate is engineer-only in v1)", op.ID)
}

// instantiateName returns the proposed module name (the first user_input param).
func instantiateName(op manifests.Op, req *request.Request) string {
	for _, p := range nonInvParams(op) {
		if v, ok := req.Params[p.Name].(string); ok {
			return v
		}
	}
	return ""
}
