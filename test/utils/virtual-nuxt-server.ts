// Stand-in for `nuxt/server` in unit tests (outside a Nuxt build).
export const useRuntimeConfig = () => ({})
export const deriveSecret = async (purpose: string) => `test-secret:${purpose}`
