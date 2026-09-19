module.exports = async () => {
  const { verifyNapCatBundle } = await import('./napcat-bundle.mjs');
  await verifyNapCatBundle();
};
