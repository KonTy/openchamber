export const shouldUseLinuxTransparency = ({
  platform,
  frameless,
  packaged,
  requested,
  forkDefault = false,
}) => (
  platform === 'linux'
  && frameless
  && (requested === '1' || (requested === undefined && packaged && forkDefault))
);
