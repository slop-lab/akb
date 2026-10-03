FROM docker:29.1.3-dind-rootless

USER root
RUN chown root:root /usr/bin/newuidmap /usr/bin/newgidmap \
 && chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

USER rootless
