export default defineEventHandler(async (event) => {
  const { group, name, type, size } = await readBody(event);
  return await useFileStorage().createUpload(group, {
    name,
    contentType: type,
    size,
    maxSize: '1GB',
    // Small parts so a few MB already exercise multipart.
    partSize: 5 * 1024 * 1024,
  });
});
