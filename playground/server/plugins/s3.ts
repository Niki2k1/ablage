export default defineNitroPlugin(() => {
  const { s3 } = useRuntimeConfig();
  if (!s3.bucket) return;
  setFileStorageProvider(createS3Provider({
    ...s3,
    publicEndpoint: s3.publicEndpoint || undefined,
    region: s3.region || undefined,
  }));
});
