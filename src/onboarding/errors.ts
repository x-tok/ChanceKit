export const onboardingError = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试。')
  .replace(/^Error invoking remote method '[^']+': Error: /, '');
