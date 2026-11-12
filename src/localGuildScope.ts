let localGuildId: string | undefined;

export function setLocalGuildScope(guildId: string | undefined): void {
  if (guildId !== undefined && !/^\d{17,20}$/.test(guildId))
    throw new Error('The local test guild must be a Discord guild ID.');
  localGuildId = guildId;
}

export function isInLocalGuildScope(subject: unknown): boolean {
  if (!localGuildId) return true;
  if (typeof subject !== 'object' || subject === null) return false;
  if ('guildId' in subject && typeof subject.guildId === 'string')
    return subject.guildId === localGuildId;
  if (
    'guild' in subject &&
    typeof subject.guild === 'object' &&
    subject.guild !== null &&
    'id' in subject.guild
  )
    return subject.guild.id === localGuildId;
  return 'id' in subject && subject.id === localGuildId;
}

export function getLocalGuildScope(): string | undefined {
  return localGuildId;
}
