FROM temporalio/temporal:1.10.1
USER root
RUN mkdir -p /data && chown temporal:temporal /data
USER temporal
