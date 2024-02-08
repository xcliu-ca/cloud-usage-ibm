podman manifest rm lospringliu/cloudreporter:ibmcloud
podman build --platform linux/arm64 --platform linux/amd64 --manifest lospringliu/cloudreporter:ibmcloud .
podman manifest push -f v2s2 lospringliu/cloudreporter:ibmcloud docker.io/lospringliu/cloudreporter:ibmcloud
#sleep 3
#podman push lospringliu/cloudreporter:ibmcloud quay.io/cidtest/cloudreporter:ibmcloud
