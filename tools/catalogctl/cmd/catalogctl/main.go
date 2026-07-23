package main

import (
	"os"
	_ "time/tzdata" // embeds the IANA tz database so --estate-tz/CCP_ESTATE_TZ (estatecfg.Resolve, ADR-0028) resolves deterministically on any runner, no system tzdata dependence

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/driftpropose" // installs cli.DriftEdit + cli.DriftPropose
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/edit"         // installs cli.Edit
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/onboard"      // installs cli.Onboard
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/plancheck"    // installs cli.PlanCheck
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/prprep"       // installs cli.PRPrepare
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/windowcheck"  // installs cli.WindowCheck
)

func main() { os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr)) }
