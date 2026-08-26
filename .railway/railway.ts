import { defineRailway, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const labelingServiceVolume = volume("labeling-service-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 500 });
  const LabelingService = service("Labeling Service", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "/Dockerfile" },
    replicas: { "europe-west4-drams3a": 1 },
    networking: { privateNetworkEndpoint: "labeling-service" },
    volumeMounts: { "/data": labelingServiceVolume },
    env: { LABELS_PATH: preserve() },
  });

  return project("Labeling Service", {
    resources: [LabelingService, labelingServiceVolume],
  });
});
