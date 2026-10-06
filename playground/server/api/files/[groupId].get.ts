export default defineEventHandler(async (event) => {
  const group = getRouterParam(event, 'groupId')!;
  const { objects } = await useFileStorage().list(group);
  return objects;
});
