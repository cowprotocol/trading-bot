#!/bin/bash

set -euo pipefail

echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin
if [ "$1" = "develop" -o "$1" = "main" ]; then # if using other branches, change branch names accordingly.
    # If image does not exist, don't use cache
    docker pull gnosispm/$DOCKERHUB_PROJECT:$1 && \
    docker build -t $DOCKERHUB_PROJECT -f docker/Dockerfile . --cache-from gnosispm/$DOCKERHUB_PROJECT:$1 || \
    docker build -t $DOCKERHUB_PROJECT -f docker/Dockerfile .
else
    docker pull gnosispm/$DOCKERHUB_PROJECT:staging && \
    docker build -t $DOCKERHUB_PROJECT -f docker/Dockerfile . --cache-from gnosispm/$DOCKERHUB_PROJECT:staging || \
    docker build -t $DOCKERHUB_PROJECT -f docker/Dockerfile .
fi
docker tag $DOCKERHUB_PROJECT gnosispm/$DOCKERHUB_PROJECT:$1
docker push gnosispm/$DOCKERHUB_PROJECT:$1
