# DIM repository policy

This project runs in an ordinary Git workspace. Host-installed DIM plugins own
workspace tooling and runtime setup; this repository supplies no lifecycle hooks
or nested Docker/Compose environment.

`repos.yml` is an optional, explicit Native Git repository-policy declaration. It
keeps `main` under review, declares ordinary `development` work, and maps the
GitHub `main` upstream and publication target. It does not install plugins, start
services, publish feature branches, or enable Native Git by being present.

Application setup and checks remain in the project documentation and package
scripts. The removed legacy Compose and shell files are not current DIM inputs.
