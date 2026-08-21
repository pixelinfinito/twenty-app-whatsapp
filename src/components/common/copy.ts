import { useCallback } from 'react';
import { useLocale } from 'twenty-sdk/front-component';

/**
 * Every word a user reads (FR-UI-5, specs/01 §7).
 *
 * The server answers in machine codes — `WINDOW_CLOSED`, `131026`, `NO_CONSENT`
 * — and never in sentences. That is what makes this file possible: rewording a
 * denial, or having counsel change the phrasing of a consent notice, is an edit
 * here and not a deploy of the send path.
 *
 * **The two languages are written side by side, not in two tables.** Parallel
 * tables let a key exist in one and not the other, and the failure is invisible
 * until a reader with the wrong locale meets an English string in a Portuguese
 * screen — or nothing at all. Paired entries make that unrepresentable, and a
 * translation that has not been done yet is visible on the line where it is
 * missing.
 *
 * Written pt-first and translated to en, not the reverse. The users are
 * Portuguese-speaking (A-6), and a Portuguese string that reads like a
 * translation of English is the tell that nobody who speaks it wrote it.
 */

export type Lang = 'pt' | 'en';

export const langOf = (locale: string | null | undefined): Lang =>
  typeof locale === 'string' && locale.toLowerCase().startsWith('pt') ? 'pt' : 'en';

type Entry = { pt: string; en: string };

const COPY = {
  // ─── Policy denials — the composer's disabled states (specs/08 §3.3) ──────
  'policy.ACCOUNT_NOT_CONNECTED': {
    pt: 'O número de WhatsApp não está ligado.',
    en: 'The WhatsApp number is not connected.',
  },
  'policy.THREAD_BLOCKED': {
    pt: 'Esta conversa está bloqueada.',
    en: 'This conversation is blocked.',
  },
  'policy.OPTED_OUT': {
    pt: 'Este contacto cancelou a subscrição.',
    en: 'This contact has unsubscribed.',
  },
  'policy.NO_CONSENT': {
    pt: 'Este contacto não deu consentimento para marketing.',
    en: 'This contact has not consented to marketing.',
  },
  'policy.WINDOW_CLOSED': {
    pt: 'A janela de 24 horas fechou. Só pode enviar um modelo aprovado.',
    en: 'The 24-hour window has closed. Only an approved template can be sent.',
  },
  'policy.TEMPLATE_UNAVAILABLE': {
    pt: 'Este modelo não está disponível para envio.',
    en: 'This template is not available to send.',
  },
  'policy.QUALITY_RED': {
    pt: 'A qualidade do número está em vermelho.',
    en: 'The number’s quality rating is red.',
  },

  'warning.WINDOW_EXPIRING_SOON': {
    pt: 'A janela fecha em breve.',
    en: 'The window closes soon.',
  },
  'warning.CONSENT_UNKNOWN_MARKETING': {
    pt: 'Sem consentimento registado para marketing.',
    en: 'No recorded marketing consent.',
  },
  'warning.QUALITY_YELLOW': {
    pt: 'A qualidade do número está em amarelo.',
    en: 'The number’s quality rating is yellow.',
  },

  // ─── Record states ────────────────────────────────────────────────────────
  'status.QUEUED': { pt: 'Em fila', en: 'Queued' },
  'status.ACCEPTED': { pt: 'Aceite', en: 'Accepted' },
  'status.SENT': { pt: 'Enviada', en: 'Sent' },
  'status.DELIVERED': { pt: 'Entregue', en: 'Delivered' },
  'status.READ': { pt: 'Lida', en: 'Read' },
  'status.PLAYED': { pt: 'Ouvida', en: 'Played' },
  'status.FAILED': { pt: 'Falhou', en: 'Failed' },

  'thread.OPEN': { pt: 'Aberta', en: 'Open' },
  'thread.AWAITING_REPLY': { pt: 'À espera de resposta', en: 'Awaiting reply' },
  'thread.CLOSED': { pt: 'Fechada', en: 'Closed' },
  'thread.NEEDS_REVIEW': { pt: 'Por identificar', en: 'Unidentified' },

  'consent.OPTED_IN': { pt: 'Subscrito', en: 'Subscribed' },
  'consent.OPTED_OUT': { pt: 'Cancelou', en: 'Unsubscribed' },
  'consent.UNKNOWN': { pt: 'Consentimento desconhecido', en: 'Consent unknown' },

  // ─── The Meta errors a rep can see on a bubble (appendix B) ───────────────
  'error.131047': {
    pt: 'Fora da janela de 24 horas — use um modelo.',
    en: 'Outside the 24-hour window — use a template.',
  },
  'error.131026': {
    pt: 'Este número não está no WhatsApp.',
    en: 'This number is not on WhatsApp.',
  },
  'error.131049': {
    pt: 'A Meta limitou as mensagens de marketing para este contacto hoje.',
    en: 'Meta capped marketing messages to this contact today.',
  },
  'error.131000': { pt: 'Erro temporário da Meta.', en: 'Temporary Meta error.' },
  'error.130429': {
    pt: 'Limite de envio atingido — tente novamente.',
    en: 'Send limit reached — try again.',
  },
  'error.132000': {
    pt: 'O modelo não corresponde às variáveis enviadas.',
    en: 'The template does not match the variables sent.',
  },
  'error.132001': {
    pt: 'O modelo não existe ou não está aprovado.',
    en: 'The template does not exist or is not approved.',
  },
  'error.132012': {
    pt: 'Um valor de variável foi recusado pela Meta.',
    en: 'Meta rejected a variable value.',
  },
  'error.133010': {
    pt: 'O número não está registado na Meta.',
    en: 'The number is not registered with Meta.',
  },
  'error.POLICY_WINDOW_CLOSED': {
    pt: 'A janela fechou antes do envio.',
    en: 'The window closed before the message was sent.',
  },
  'error.POLICY_OPTED_OUT': {
    pt: 'O contacto cancelou a subscrição antes do envio.',
    en: 'The contact unsubscribed before the message was sent.',
  },
  'error.POLICY_TEMPLATE_UNAVAILABLE': {
    pt: 'O modelo deixou de estar disponível.',
    en: 'The template became unavailable.',
  },
  'error.POLICY_ACCOUNT_ERROR': {
    pt: 'O número deixou de estar ligado.',
    en: 'The number is no longer connected.',
  },
  'error.UNKNOWN_ACCEPTANCE': {
    pt: 'Resultado desconhecido — verifique antes de reenviar.',
    en: 'Unknown outcome — check before resending.',
  },
  'error.MEDIA_TOO_LARGE': {
    pt: 'O ficheiro excede o limite da Meta.',
    en: 'The file exceeds Meta’s limit.',
  },
  'error.MEDIA_UNAVAILABLE': {
    pt: 'O ficheiro já não está disponível na Meta.',
    en: 'The file is no longer available from Meta.',
  },
  /**
   * The one error sentence that carries its own detail.
   *
   * Everywhere else the raw text is Meta's, written for a developer reading an
   * API response, and hiding it is right. Here it is ours — "only /files/
   * paths are workspace files", "HTTP 404" — and it is the difference between
   * a rep re-copying the address and a rep giving up (D-58).
   */
  'error.ATTACHMENT_UNREADABLE': {
    pt: 'Não foi possível ler o ficheiro no Twenty: {detail}',
    en: 'The file could not be read from Twenty: {detail}',
  },
  'error.CANCELLED': { pt: 'Cancelada.', en: 'Cancelled.' },
  'error.INTERNAL_TIMEOUT': { pt: 'Tempo esgotado.', en: 'Timed out.' },
  'error.CONFIG_MISSING': { pt: 'Configuração em falta.', en: 'Missing configuration.' },
  'error.unknown': { pt: 'Erro não catalogado.', en: 'Uncatalogued error.' },

  // ─── Campaign exclusions (specs/07) ───────────────────────────────────────
  'exclusion.OPTED_OUT': { pt: 'Cancelou a subscrição', en: 'Unsubscribed' },
  'exclusion.NO_CONSENT': { pt: 'Sem consentimento', en: 'No consent' },
  'exclusion.INVALID_PHONE': { pt: 'Número inválido', en: 'Invalid number' },
  'exclusion.DUPLICATE': { pt: 'Duplicado', en: 'Duplicate' },
  'exclusion.MISSING_VARIABLES': { pt: 'Variáveis em falta', en: 'Missing variables' },
  'exclusion.BLOCKED': { pt: 'Conversa bloqueada', en: 'Blocked conversation' },

  // ─── Shared verbs ─────────────────────────────────────────────────────────
  'common.cancel': { pt: 'Cancelar', en: 'Cancel' },
  'common.save': { pt: 'Guardar', en: 'Save' },
  'common.back': { pt: 'Voltar', en: 'Back' },
  'common.continue': { pt: 'Continuar', en: 'Continue' },
  'common.refresh': { pt: 'Actualizar', en: 'Refresh' },
  'common.retry': { pt: 'Tentar de novo', en: 'Try again' },
  'common.unavailable': {
    pt: 'Não foi possível ler os dados.',
    en: 'The data could not be read.',
  },
  'common.copy': { pt: 'Copiar', en: 'Copy' },
  'common.loading': { pt: 'A carregar…', en: 'Loading…' },
  'common.none': { pt: 'Nenhuma', en: 'None' },
  'common.yes': { pt: 'sim', en: 'yes' },
  'common.no': { pt: 'não', en: 'no' },
  'common.dismiss': { pt: 'Fechar aviso', en: 'Dismiss' },
  'common.clear': { pt: 'Limpar', en: 'Clear' },
  'common.more': { pt: 'Mais', en: 'More' },
  'common.less': { pt: 'Menos', en: 'Less' },

  // ─── Chat ─────────────────────────────────────────────────────────────────
  'chat.windowOpen': { pt: 'Janela aberta', en: 'Window open' },
  'chat.windowClosed': { pt: 'Janela fechada', en: 'Window closed' },
  'chat.closesIn': { pt: 'fecha em {time}', en: 'closes in {time}' },
  'chat.loadOlder': { pt: 'Carregar mensagens anteriores', en: 'Load earlier messages' },
  'chat.empty': {
    pt: 'Ainda não há mensagens nesta conversa.',
    en: 'No messages in this conversation yet.',
  },
  'chat.noThread': {
    pt: 'Este contacto ainda não tem conversa de WhatsApp.',
    en: 'This contact has no WhatsApp conversation yet.',
  },
  'chat.start': { pt: 'Iniciar conversa', en: 'Start a conversation' },
  'chat.placeholder': { pt: 'Escreva uma mensagem', en: 'Write a message' },
  'chat.send': { pt: 'Enviar', en: 'Send' },
  'chat.chooseTemplate': { pt: 'Escolher modelo', en: 'Choose a template' },
  'chat.templateHeader': { pt: 'Cabeçalho', en: 'Header' },
  // The three media header formats, named as the thing the rep has to find.
  'chat.templateHeader.IMAGE': { pt: 'Imagem', en: 'Image' },
  'chat.templateHeader.VIDEO': { pt: 'Vídeo', en: 'Video' },
  'chat.templateHeader.DOCUMENT': { pt: 'Documento', en: 'Document' },
  'chat.templateHeaderMedia': {
    pt: 'Ficheiro do cabeçalho, guardado no Twenty',
    en: 'Header file, stored in Twenty',
  },
  'chat.fileUrlPlaceholder': {
    pt: 'https://…/files/attachment/…',
    en: 'https://…/files/attachment/…',
  },
  'chat.templateButton': { pt: 'Botão', en: 'Button' },
  'chat.templateButtonUrl': { pt: 'Ligação do botão', en: 'Button link' },
  'chat.templateCopyCode': { pt: 'Código a copiar', en: 'Copy code' },
  'chat.retry': { pt: 'Repetir', en: 'Retry' },
  'chat.details': { pt: 'Ver detalhes', en: 'Show details' },
  'chat.voiceNote': { pt: 'Mensagem de voz', en: 'Voice message' },
  'chat.download': { pt: 'Transferir ({size})', en: 'Download ({size})' },
  'chat.unsupported': { pt: 'Mensagem não suportada', en: 'Unsupported message' },
  'chat.today': { pt: 'Hoje', en: 'Today' },
  'chat.yesterday': { pt: 'Ontem', en: 'Yesterday' },
  'chat.reconnect': { pt: 'Retomar actualizações', en: 'Resume updates' },
  'chat.suspended': { pt: 'Actualizações em pausa.', en: 'Updates paused.' },
  'chat.offline': { pt: 'Sem ligação ao servidor.', en: 'No connection to the server.' },
  'chat.sending': { pt: 'A enviar…', en: 'Sending…' },
  'chat.campaign': { pt: 'Campanha', en: 'Campaign' },
  'chat.aiAgent': { pt: 'Agente de IA', en: 'AI agent' },
  'chat.template': { pt: 'Modelo', en: 'Template' },
  'chat.needsReview': { pt: 'Por identificar', en: 'Unidentified' },
  'chat.blocked': { pt: 'Bloqueada', en: 'Blocked' },
  'chat.testAccount': { pt: 'Número de teste', en: 'Test number' },
  'chat.qualityYellow': { pt: 'Qualidade do número: amarelo', en: 'Number quality: yellow' },
  'chat.qualityRed': { pt: 'Qualidade do número: vermelho', en: 'Number quality: red' },
  'chat.accountError': {
    pt: 'O número de WhatsApp não está ligado.',
    en: 'The WhatsApp number is not connected.',
  },
  'chat.block': { pt: 'Bloquear', en: 'Block' },
  'chat.unblock': { pt: 'Desbloquear', en: 'Unblock' },
  'chat.blockConfirmTitle': { pt: 'Bloquear esta conversa?', en: 'Block this conversation?' },
  'chat.blockConfirmSubtitle': {
    pt: 'Nenhuma mensagem será enviada nem recebida enquanto estiver bloqueada. Pode desbloquear a qualquer momento.',
    en: 'Nothing will be sent or received while it is blocked. You can unblock at any time.',
  },
  'chat.close': { pt: 'Fechar', en: 'Close' },
  'chat.reopen': { pt: 'Reabrir', en: 'Reopen' },
  'chat.noTemplates': {
    pt: 'Não há modelos publicados para este número.',
    en: 'No published templates for this number.',
  },
  'chat.missing': { pt: 'Em falta', en: 'Missing' },
  'chat.noPermission': { pt: 'Sem permissão para enviar.', en: 'You may not send messages.' },
  'chat.detailsHide': { pt: 'Ocultar detalhes', en: 'Hide details' },
  'chat.file': { pt: 'ficheiro', en: 'file' },
  'chat.quoted': { pt: 'Em resposta a uma mensagem', en: 'In reply to a message' },
  'chat.detail.address': { pt: 'Morada', en: 'Address' },
  'chat.detail.coordinates': { pt: 'Coordenadas', en: 'Coordinates' },
  'chat.detail.contact': { pt: 'Contacto', en: 'Contact' },
  'chat.detail.phone': { pt: 'Telefone', en: 'Phone' },
  'chat.detail.description': { pt: 'Descrição', en: 'Description' },

  // ─── The conversation's own empty states (review §"empty state") ──────────
  'chat.emptyBody': {
    pt: 'Escreva a primeira mensagem, ou escolha um modelo aprovado.',
    en: 'Write the first message, or pick an approved template.',
  },
  'chat.noThreadBody': {
    pt: 'Envie um modelo aprovado para começar. A resposta do contacto abre a janela de 24 horas e a partir daí pode escrever livremente.',
    en: 'Send an approved template to begin. The contact’s reply opens the 24-hour window, and from then on you can write freely.',
  },
  'chat.startWithTemplate': { pt: 'Começar com um modelo', en: 'Start with a template' },
  'chat.windowClosedTitle': { pt: 'A janela de 24 horas fechou', en: 'The 24-hour window has closed' },
  'chat.windowClosedBody': {
    pt: 'Fora da janela só um modelo aprovado chega ao contacto. A resposta dele reabre a janela.',
    en: 'Outside the window only an approved template reaches the contact. Their reply reopens it.',
  },
  'chat.consentTitle': { pt: 'Este contacto não pode ser contactado', en: 'This contact cannot be messaged' },
  'chat.reviewConsent': { pt: 'Rever consentimento', en: 'Review consent' },
  'chat.reviewConsentBody': {
    pt: 'O consentimento vive no registo da Pessoa, no campo de subscrição de WhatsApp.',
    en: 'Consent lives on the Person record, in the WhatsApp subscription field.',
  },
  'chat.setupTitle': { pt: 'Falta ligar um número', en: 'No number is connected' },
  'chat.setupBody': {
    pt: 'Um administrador liga o número em Definições → Aplicações → WhatsApp. Até lá não é possível enviar nem receber.',
    en: 'An admin connects the number in Settings → Applications → WhatsApp. Until then nothing can be sent or received.',
  },
  'chat.blockedTitle': {
    pt: 'Não é possível enviar agora',
    en: 'Sending is not possible right now',
  },
  'chat.blockedBody': {
    pt: 'O servidor recusou o envio para este contacto.',
    en: 'The server refused a send to this contact.',
  },
  'chat.noPhoneTitle': { pt: 'Sem número utilizável', en: 'No usable number' },
  'chat.noPhoneBody': {
    pt: 'Este contacto não tem um telefone que possa ser convertido num número de WhatsApp. Corrija-o no registo da Pessoa.',
    en: 'This contact has no phone that converts to a WhatsApp number. Fix it on the Person record.',
  },

  // ─── Who is handling a conversation (FR-THR-3) ────────────────────────────
  'chat.assignedToYou': { pt: 'Sua', en: 'Yours' },
  'chat.assignedToOther': { pt: 'Com responsável', en: 'Assigned' },
  'chat.unassigned': { pt: 'Sem responsável', en: 'Unassigned' },
  'chat.assignToMe': { pt: 'Atribuir a mim', en: 'Assign to me' },
  'chat.unassign': { pt: 'Remover responsável', en: 'Unassign' },
  'chat.assignFailed': {
    pt: 'Não foi possível mudar o responsável.',
    en: 'The owner could not be changed.',
  },

  // ─── Message actions (spec §"Message action model") ───────────────────────
  'chat.action.react': { pt: 'Reagir', en: 'React' },
  'chat.action.reply': { pt: 'Responder', en: 'Reply' },
  'chat.action.copy': { pt: 'Copiar texto', en: 'Copy text' },
  'chat.action.copied': { pt: 'Copiado', en: 'Copied' },
  'chat.action.copyFailed': {
    pt: 'Não foi possível copiar.',
    en: 'The text could not be copied.',
  },
  'chat.action.download': { pt: 'Transferir', en: 'Download' },
  'chat.action.openImage': { pt: 'Abrir imagem', en: 'Open image' },
  'chat.action.openVideo': { pt: 'Abrir vídeo', en: 'Open video' },
  'chat.action.openMap': { pt: 'Abrir mapa', en: 'Open map' },
  'chat.action.openDocument': { pt: 'Abrir documento', en: 'Open document' },
  'chat.action.moreEmoji': { pt: 'Mais emoji', en: 'More emoji' },
  'chat.action.removeReaction': { pt: 'Remover a sua reacção', en: 'Remove your reaction' },
  'chat.action.reactWith': { pt: 'Reagir com {emoji}', en: 'React with {emoji}' },
  'chat.action.close': { pt: 'Fechar', en: 'Close' },
  'chat.action.forMessage': {
    pt: 'Acções para esta mensagem',
    en: 'Actions for this message',
  },

  // ─── Reply and quote strip (spec §"Reply UX") ─────────────────────────────
  'chat.replyingTo': { pt: 'A responder a {sender}', en: 'Replying to {sender}' },
  'chat.you': { pt: 'Si', en: 'You' },
  'chat.cancelReply': { pt: 'Cancelar resposta', en: 'Cancel reply' },
  'chat.quoteUnavailable': {
    pt: 'Mensagem original indisponível',
    en: 'Original message unavailable',
  },

  // ─── What each content type is called ─────────────────────────────────────
  'chat.type.TEXT': { pt: 'Mensagem', en: 'Message' },
  'chat.type.IMAGE': { pt: 'Imagem', en: 'Photo' },
  'chat.type.VIDEO': { pt: 'Vídeo', en: 'Video' },
  'chat.type.AUDIO': { pt: 'Áudio', en: 'Audio' },
  'chat.type.DOCUMENT': { pt: 'Documento', en: 'Document' },
  'chat.type.STICKER': { pt: 'Autocolante', en: 'Sticker' },
  'chat.type.LOCATION': { pt: 'Localização', en: 'Location' },
  'chat.type.CONTACTS': { pt: 'Contacto', en: 'Contact' },
  'chat.type.TEMPLATE': { pt: 'Modelo', en: 'Template' },
  'chat.type.INTERACTIVE': { pt: 'Mensagem interactiva', en: 'Interactive message' },
  'chat.type.BUTTON_REPLY': { pt: 'Resposta rápida', en: 'Quick reply' },
  'chat.type.LIST_REPLY': { pt: 'Opção da lista', en: 'List option' },
  'chat.type.REACTION': { pt: 'Reacção', en: 'Reaction' },
  'chat.type.SYSTEM': { pt: 'Evento do sistema', en: 'System event' },
  /**
   * Reached only through `chat.type.${type}`, like every row above it — but this
   * is the one a scanner would never see used, because `UNSUPPORTED` is the
   * branch that exists precisely for types nobody has written code for.
   */
  'chat.type.UNSUPPORTED': { pt: 'Mensagem não suportada', en: 'Unsupported message' },

  // ─── Rich renderers (spec §"Rich message renderer registry") ──────────────
  'chat.voiceMessage': { pt: 'Mensagem de voz', en: 'Voice message' },
  'chat.audioFile': { pt: 'Ficheiro de áudio', en: 'Audio file' },
  'chat.duration': { pt: '{minutes}:{seconds}', en: '{minutes}:{seconds}' },
  'chat.imageFailed': {
    pt: 'A imagem não pôde ser mostrada.',
    en: 'The image could not be shown.',
  },
  'chat.playVideo': { pt: 'Reproduzir', en: 'Play' },
  'chat.mediaPending': { pt: 'A transferir…', en: 'Downloading…' },
  'chat.selectedQuickReply': {
    pt: 'Escolheu uma resposta rápida',
    en: 'Selected a quick reply',
  },
  'chat.selectedFromList': { pt: 'Escolheu da lista', en: 'Selected from the list' },
  'chat.flowResponse': { pt: 'Resposta a um formulário', en: 'Form response' },
  'chat.interactiveButtons': {
    pt: 'Botões de resposta rápida',
    en: 'Quick reply buttons',
  },
  'chat.interactiveList': { pt: 'Mensagem com lista', en: 'List message' },
  'chat.listOptions': { pt: '{count} opções', en: '{count} options' },
  'chat.viewOptions': { pt: 'Ver opções', en: 'View options' },
  'chat.hideOptions': { pt: 'Ocultar opções', en: 'Hide options' },
  'chat.systemEvent': { pt: 'Evento do sistema', en: 'System event' },
  'chat.unsupportedBody': {
    pt: 'Esta mensagem chegou num formato que a aplicação ainda não mostra. O conteúdo original ficou guardado.',
    en: 'This message arrived in a format the app does not render yet. The original is stored.',
  },

  // ─── Location and contact cards (spec §"Location and vCard design") ───────
  'chat.locationShared': { pt: 'Localização partilhada', en: 'Shared location' },
  'chat.coordinates': { pt: '{latitude}, {longitude}', en: '{latitude}, {longitude}' },
  'chat.contactShared': { pt: 'Contacto partilhado', en: 'Shared contact' },
  'chat.openPerson': { pt: 'Abrir contacto', en: 'Open person' },
  'chat.createPerson': { pt: 'Criar contacto', en: 'Create person' },
  'chat.creatingPerson': { pt: 'A criar…', en: 'Creating…' },
  'chat.contactReview': {
    pt: 'Estes dados são de terceiros. Reveja antes de criar um contacto.',
    en: 'This is third-party data. Review it before creating a person.',
  },

  // ─── Message details panel ────────────────────────────────────────────────
  'chat.detail.sent': { pt: 'Enviada', en: 'Sent' },
  'chat.detail.delivered': { pt: 'Entregue', en: 'Delivered' },
  'chat.detail.read': { pt: 'Lida', en: 'Read' },
  'chat.detail.accepted': { pt: 'Aceite pela Meta', en: 'Accepted by Meta' },
  'chat.detail.played': { pt: 'Ouvida', en: 'Played' },
  'chat.detail.failed': { pt: 'Falhou', en: 'Failed' },
  'chat.detail.type': { pt: 'Tipo', en: 'Type' },
  'chat.detail.template': { pt: 'Modelo', en: 'Template' },
  'chat.detail.language': { pt: 'Idioma', en: 'Language' },
  'chat.detail.category': { pt: 'Categoria', en: 'Category' },
  'chat.detail.file': { pt: 'Ficheiro', en: 'File' },
  'chat.detail.size': { pt: 'Tamanho', en: 'Size' },
  'chat.detail.buttonId': { pt: 'Identificador do botão', en: 'Button id' },
  'chat.detail.rowId': { pt: 'Identificador da linha', en: 'Row id' },
  'chat.detail.organization': { pt: 'Organização', en: 'Organisation' },
  'chat.detail.email': { pt: 'Email', en: 'Email' },
  'chat.detail.reactions': { pt: 'Reacções', en: 'Reactions' },
  'chat.detail.attempts': { pt: 'Tentativas', en: 'Attempts' },

  // ─── Composer ＋ sheet (spec §"Composer redesign") ─────────────────────────
  'chat.attach': { pt: 'Anexar', en: 'Attach' },
  'chat.collapsePanel': { pt: 'Recolher e ver a conversa', en: 'Collapse and see the conversation' },
  'chat.expandPanel': { pt: 'Expandir', en: 'Expand' },
  'chat.attachTitle': { pt: 'Enviar…', en: 'Send…' },
  'chat.emoji': { pt: 'Emoji', en: 'Emoji' },
  'chat.attachPhoto': { pt: 'Foto ou vídeo', en: 'Photo or video' },
  'chat.attachDocument': { pt: 'Documento', en: 'Document' },
  'chat.attachVoice': { pt: 'Mensagem de voz', en: 'Voice message' },
  'chat.attachLocation': { pt: 'Localização', en: 'Location' },
  'chat.attachContact': { pt: 'Contacto', en: 'Contact' },
  'chat.attachQuickReplies': { pt: 'Respostas rápidas', en: 'Quick replies' },
  'chat.attachList': { pt: 'Mensagem com lista', en: 'List message' },
  'chat.attachTemplate': { pt: 'Modelo aprovado', en: 'Approved template' },
  'chat.unavailableHere': {
    pt: 'Indisponível nesta conversa',
    en: 'Not available in this conversation',
  },
  /**
   * Two sources, not three: "from this device" was tried and retired — the
   * sandbox bridge hands a picked file's metadata over without its bytes
   * (D-53 field correction, specs/00), so every device pick failed.
   */
  'chat.sourceLabel': { pt: 'Origem do ficheiro', en: 'File source' },
  'chat.source.recent': { pt: 'Recentes da conversa', en: 'Recent in this chat' },
  'chat.source.link': { pt: 'Já no Twenty', en: 'Already in Twenty' },
  // ─── The workspace-file picker inside "already in Twenty" ─────────────────
  'chat.fileSearchLabel': {
    pt: 'Procurar ficheiros no Twenty',
    en: 'Search files in Twenty',
  },
  'chat.fileSearching': { pt: 'A procurar…', en: 'Searching…' },
  'chat.fileSearchNone': {
    pt: 'Nenhum ficheiro corresponde. Cole o endereço abaixo.',
    en: 'No files match. Paste the address below.',
  },
  'chat.recentNone': {
    pt: 'Ainda não há ficheiros nesta conversa.',
    en: 'No files in this conversation yet.',
  },
  'chat.recentHint': {
    pt: 'Reutilize um ficheiro já enviado ou recebido nesta conversa.',
    en: 'Reuse a file already sent or received in this conversation.',
  },

  // ─── Sending media from Twenty's own files ────────────────────────────────
  'chat.fileUrlLabel': { pt: 'Endereço do ficheiro no Twenty', en: 'Twenty file URL' },
  'chat.fileUrlHint': {
    pt: 'Abra o ficheiro a partir do registo no Twenty e copie o endereço da barra do navegador. Tem de conter /files/.',
    en: 'Open the file from its record in Twenty and copy the address from the browser bar. It has to contain /files/.',
  },
  'chat.fileNameLabel': { pt: 'Nome do ficheiro', en: 'File name' },
  'chat.captionLabel': { pt: 'Legenda (opcional)', en: 'Caption (optional)' },
  'chat.mediaKindLabel': { pt: 'Tipo de anexo', en: 'Attachment type' },
  'chat.sendAttachment': { pt: 'Enviar anexo', en: 'Send attachment' },
  'chat.fileUrlRequired': {
    pt: 'Indique o endereço do ficheiro.',
    en: 'Enter the file’s address.',
  },
  'chat.fileUrlInvalid': {
    pt: 'Este endereço não é válido.',
    en: 'That address is not valid.',
  },

  // ─── Voice recording ──────────────────────────────────────────────────────
  'chat.recordStart': { pt: 'Gravar mensagem de voz', en: 'Record a voice message' },
  'chat.recordStop': { pt: 'Parar gravação', en: 'Stop recording' },
  'chat.recording': { pt: 'A gravar… {duration}', en: 'Recording… {duration}' },
  'chat.recordReview': { pt: 'Ouça antes de enviar.', en: 'Listen before sending.' },
  'chat.recordDiscard': { pt: 'Descartar', en: 'Discard' },
  'chat.recordUnavailable': {
    pt: 'A gravação de áudio não está disponível neste navegador.',
    en: 'Audio recording is not available in this browser.',
  },
  'chat.recordDenied': {
    pt: 'Sem acesso ao microfone. Autorize-o no navegador e tente de novo.',
    en: 'No microphone access. Allow it in the browser and try again.',
  },
  'chat.recordUploading': { pt: 'A carregar a gravação…', en: 'Uploading the recording…' },
  'chat.recordUploadFailed': {
    pt: 'Não foi possível carregar a gravação.',
    en: 'The recording could not be uploaded.',
  },

  // ─── Location composer ────────────────────────────────────────────────────
  'chat.locationName': { pt: 'Nome do local (opcional)', en: 'Place name (optional)' },
  'chat.locationAddress': { pt: 'Morada (opcional)', en: 'Address (optional)' },
  'chat.latitude': { pt: 'Latitude', en: 'Latitude' },
  'chat.longitude': { pt: 'Longitude', en: 'Longitude' },
  'chat.sendLocation': { pt: 'Enviar localização', en: 'Send location' },
  'chat.coordinatesRequired': {
    pt: 'Indique uma latitude entre -90 e 90 e uma longitude entre -180 e 180.',
    en: 'Enter a latitude between -90 and 90 and a longitude between -180 and 180.',
  },

  // ─── Contact composer ─────────────────────────────────────────────────────
  'chat.contactName': { pt: 'Nome', en: 'Name' },
  'chat.contactPhone': { pt: 'Telefone', en: 'Phone' },
  'chat.contactOrganization': { pt: 'Organização (opcional)', en: 'Organisation (optional)' },
  'chat.sendContact': { pt: 'Enviar contacto', en: 'Send contact' },
  'chat.contactNameRequired': { pt: 'Indique um nome.', en: 'Enter a name.' },
  'chat.useThisPerson': { pt: 'Usar este contacto', en: 'Use this person' },

  // ─── Interactive builders (spec §"Interactive-message authoring") ─────────
  'builder.header': { pt: 'Cabeçalho (opcional)', en: 'Header (optional)' },
  'builder.body': { pt: 'Texto', en: 'Body' },
  'builder.footer': { pt: 'Rodapé (opcional)', en: 'Footer (optional)' },
  'builder.buttons': { pt: 'Botões', en: 'Buttons' },
  'builder.buttonTitle': { pt: 'Título do botão {index}', en: 'Button {index} title' },
  'builder.addButton': { pt: 'Adicionar botão', en: 'Add a button' },
  'builder.removeButton': { pt: 'Remover botão {index}', en: 'Remove button {index}' },
  'builder.buttonLabel': { pt: 'Texto do botão da lista', en: 'List button label' },
  'builder.section': { pt: 'Secção {index}', en: 'Section {index}' },
  'builder.sectionTitle': { pt: 'Título da secção {index}', en: 'Section {index} title' },
  'builder.addSection': { pt: 'Adicionar secção', en: 'Add a section' },
  'builder.removeSection': { pt: 'Remover secção {index}', en: 'Remove section {index}' },
  'builder.row': { pt: 'Linha {index}', en: 'Row {index}' },
  'builder.rowTitle': { pt: 'Título da linha {index}', en: 'Row {index} title' },
  'builder.rowDescription': {
    pt: 'Descrição da linha {index} (opcional)',
    en: 'Row {index} description (optional)',
  },
  'builder.addRow': { pt: 'Adicionar linha', en: 'Add a row' },
  'builder.removeRow': { pt: 'Remover linha {index}', en: 'Remove row {index}' },
  'builder.moveUp': { pt: 'Mover para cima', en: 'Move up' },
  'builder.moveDown': { pt: 'Mover para baixo', en: 'Move down' },
  'builder.rowsUsed': { pt: '{used} / {limit} linhas', en: '{used} / {limit} rows' },
  'builder.preview': { pt: 'Como o contacto vê', en: 'What the contact sees' },
  'builder.sendButtons': { pt: 'Enviar respostas rápidas', en: 'Send quick replies' },
  'builder.sendList': { pt: 'Enviar lista', en: 'Send list' },
  'builder.quickRepliesTitle': { pt: 'Respostas rápidas', en: 'Quick replies' },
  'builder.listTitle': { pt: 'Mensagem com lista', en: 'List message' },
  'builder.idsAreAutomatic': {
    pt: 'Os identificadores são gerados automaticamente e não mudam quando edita o texto.',
    en: 'Ids are generated automatically and do not change when you edit the text.',
  },

  /**
   * Field-addressed rejections, keyed by the code the validator returns. One
   * sentence per *kind* of mistake, because "invalid" under a box is the API
   * error message again in a nicer font.
   */
  'builder.error.REQUIRED': { pt: 'Obrigatório.', en: 'Required.' },
  'builder.error.TOO_LONG': {
    pt: 'Demasiado longo — máximo {limit} caracteres.',
    en: 'Too long — {limit} characters at most.',
  },
  'builder.error.TOO_FEW': { pt: 'Faltam entradas (mínimo {limit}).', en: 'Too few (at least {limit}).' },
  'builder.error.TOO_MANY': {
    pt: 'Demasiadas entradas (máximo {limit}).',
    en: 'Too many (at most {limit}).',
  },
  'builder.error.DUPLICATE_ID': {
    pt: 'Este identificador já é usado por outra entrada.',
    en: 'Another entry already uses this id.',
  },
  'builder.error.UNSUPPORTED': {
    pt: 'Este formato não é suportado.',
    en: 'That format is not supported.',
  },
  /**
   * The specific refusal, not the generic one. "That format is not supported"
   * left a rep re-typing a perfectly valid address that simply pointed
   * somewhere the workspace cannot read from (D-58).
   */
  'builder.error.NOT_A_FILE_URL': {
    pt: 'Só é possível enviar ficheiros guardados no Twenty — o endereço tem de conter /files/.',
    en: 'Only files stored in Twenty can be sent — the address has to contain /files/.',
  },
  'builder.invalid': {
    pt: 'Corrija os campos assinalados antes de enviar.',
    en: 'Fix the highlighted fields before sending.',
  },

  // ─── Inbox ────────────────────────────────────────────────────────────────
  'inbox.hideList': { pt: 'Ocultar lista', en: 'Hide list' },
  'inbox.showList': { pt: 'Mostrar lista', en: 'Show list' },
  'inbox.mine': { pt: 'Minhas', en: 'Mine' },
  'inbox.unassigned': { pt: 'Sem responsável', en: 'Unassigned' },
  'inbox.all': { pt: 'Todas', en: 'All' },
  'inbox.unread': { pt: 'Por ler', en: 'Unread' },
  'inbox.campaign_replies': { pt: 'Respostas a campanhas', en: 'Campaign replies' },
  'inbox.window_expiring': { pt: 'A fechar', en: 'Closing soon' },
  'inbox.closed': { pt: 'Fechadas', en: 'Closed' },
  'inbox.pick': { pt: 'Escolha uma conversa', en: 'Pick a conversation' },
  'inbox.pickBody': {
    pt: 'A conversa escolhida abre aqui, com o histórico e a caixa de escrita.',
    en: 'The conversation you pick opens here, with its history and the composer.',
  },
  'inbox.conversations': { pt: 'Conversas', en: 'Conversations' },
  'inbox.empty': { pt: 'Nenhuma conversa neste filtro.', en: 'No conversations in this filter.' },

  'inbox.search': { pt: 'Procurar conversas', en: 'Search conversations' },
  'inbox.searchScope': {
    pt: 'A procurar nas {count} conversas já carregadas.',
    en: 'Searching the {count} conversations already loaded.',
  },
  'inbox.noMatches': { pt: 'Nada corresponde a “{query}”.', en: 'Nothing matches “{query}”.' },
  'inbox.clearSearch': { pt: 'Limpar a procura', en: 'Clear the search' },
  'inbox.moreFilters': { pt: 'Mais filtros', en: 'More filters' },
  'inbox.fewerFilters': { pt: 'Menos filtros', en: 'Fewer filters' },
  'inbox.filterCount': { pt: '{label}, {count} conversas', en: '{label}, {count} conversations' },

  'inbox.empty.mine': { pt: 'Nada atribuído a si.', en: 'Nothing assigned to you.' },
  'inbox.empty.mineBody': {
    pt: 'As conversas de que se encarregar aparecem aqui. Comece pelas que ainda não têm responsável.',
    en: 'Conversations you take on appear here. Start with the ones nobody owns yet.',
  },
  'inbox.empty.unassigned': {
    pt: 'Todas as conversas têm responsável.',
    en: 'Every conversation has an owner.',
  },
  'inbox.empty.unassignedBody': {
    pt: 'Nada está à espera de alguém a quem chamar.',
    en: 'Nothing is waiting for someone to claim it.',
  },
  'inbox.empty.all': { pt: 'Ainda não há conversas.', en: 'No conversations yet.' },
  'inbox.empty.allBody': {
    pt: 'Uma conversa começa quando um cliente escreve para o seu número, ou quando envia um modelo a partir de um contacto.',
    en: 'A conversation starts when a customer writes to your number, or when you send a template from a contact.',
  },
  'inbox.empty.unread': { pt: 'Tudo lido.', en: 'All caught up.' },
  'inbox.empty.unreadBody': {
    pt: 'Nenhuma conversa tem mensagens por ler. As novas mensagens aparecem aqui.',
    en: 'No conversation has unread messages. New messages show up here.',
  },
  /**
   * The list can empty while a conversation stays open beside it — closing or
   * assigning the open thread is what removes it from the current filter.
   */
  'inbox.openNotInFilter': {
    pt: 'A conversa aberta já não pertence a este filtro.',
    en: 'The open conversation is no longer in this filter.',
  },
  'inbox.empty.campaign_replies': {
    pt: 'Ainda ninguém respondeu a uma campanha.',
    en: 'Nobody has replied to a campaign yet.',
  },
  'inbox.empty.campaign_repliesBody': {
    pt: 'As respostas a mensagens de campanha juntam-se aqui, separadas do resto da caixa.',
    en: 'Replies to campaign messages collect here, kept apart from the rest of the inbox.',
  },
  'inbox.empty.window_expiring': {
    pt: 'Nenhuma janela fecha nas próximas duas horas.',
    en: 'No window closes in the next two hours.',
  },
  'inbox.empty.window_expiringBody': {
    pt: 'Este filtro mostra as conversas que perdem a janela de 24 horas em breve — as que valem uma resposta antes de exigirem um modelo.',
    en: 'This filter shows conversations about to lose their 24-hour window — the ones worth answering before they need a template.',
  },
  'inbox.empty.closed': { pt: 'Nenhuma conversa fechada.', en: 'No closed conversations.' },
  'inbox.empty.closedBody': {
    pt: 'Fechar uma conversa é só uma etiqueta: qualquer mensagem nova volta a abri-la.',
    en: 'Closing a conversation is only a label: any new message reopens it.',
  },
  'inbox.seeAll': { pt: 'Ver todas', en: 'See all' },
  'inbox.seeUnassigned': { pt: 'Ver sem responsável', en: 'See unassigned' },
  'inbox.keyboardHint': {
    pt: 'Teclado: J e K mudam de conversa, A atribui-a a si.',
    en: 'Keyboard: J and K move between conversations, A assigns one to you.',
  },

  // ─── Live toasts (D-10 layer 2) ───────────────────────────────────────────
  'toast.newMessage': { pt: 'Nova mensagem de {name}', en: 'New message from {name}' },
  'toast.newMessages': {
    pt: '{count} conversas com mensagens novas',
    en: '{count} conversations with new messages',
  },

  // ─── Campaigns ────────────────────────────────────────────────────────────
  'campaign.title': { pt: 'Campanhas', en: 'Campaigns' },
  'campaign.new': { pt: 'Nova campanha', en: 'New campaign' },
  /** "Continue" rather than "Edit": the builder reopens where it was left. */
  'campaign.edit': { pt: 'Continuar a editar', en: 'Continue editing' },
  'campaign.none': { pt: 'Ainda não há campanhas.', en: 'No campaigns yet.' },
  'campaign.noneBody': {
    pt: 'Uma campanha envia um modelo aprovado a uma audiência escolhida, e mostra entregas, respostas e custo à medida que decorre.',
    en: 'A campaign sends an approved template to a chosen audience, and shows deliveries, replies and cost as it runs.',
  },

  'campaign.status.DRAFT': { pt: 'Rascunho', en: 'Draft' },
  'campaign.status.SNAPSHOTTING': { pt: 'A construir audiência', en: 'Building audience' },
  'campaign.status.READY': { pt: 'Pronta', en: 'Ready' },
  'campaign.status.SCHEDULED': { pt: 'Agendada', en: 'Scheduled' },
  'campaign.status.RUNNING': { pt: 'A decorrer', en: 'Running' },
  'campaign.status.PAUSED': { pt: 'Em pausa', en: 'Paused' },
  'campaign.status.TIER_WAITING': { pt: 'À espera do escalão', en: 'Waiting on the tier' },
  'campaign.status.COMPLETED': { pt: 'Concluída', en: 'Completed' },
  'campaign.status.CANCELLED': { pt: 'Cancelada', en: 'Cancelled' },
  'campaign.status.FAILED': { pt: 'Falhou', en: 'Failed' },

  'campaign.search': { pt: 'Procurar campanhas', en: 'Search campaigns' },
  'campaign.noMatches': {
    pt: 'Nenhuma campanha corresponde a este filtro.',
    en: 'No campaign matches this filter.',
  },
  'campaign.filter.all': { pt: 'Todas', en: 'All' },
  'campaign.filter.drafts': { pt: 'Rascunhos', en: 'Drafts' },
  'campaign.filter.scheduled': { pt: 'Agendadas', en: 'Scheduled' },
  'campaign.filter.running': { pt: 'A decorrer', en: 'Running' },
  'campaign.filter.completed': { pt: 'Concluídas', en: 'Completed' },
  'campaign.filter.attention': { pt: 'A precisar de atenção', en: 'Needs attention' },
  'campaign.filter.archived': { pt: 'Arquivadas', en: 'Archived' },
  'campaign.open': { pt: 'Abrir campanha', en: 'Open campaign' },
  // The list row's quiet second line: who it targets, from which number.
  'campaign.audienceView': { pt: 'Vista guardada', en: 'Saved view' },
  'campaign.audienceManual': {
    pt: '{count} contactos escolhidos',
    en: '{count} chosen contacts',
  },
  /** A zero-recipient draft the builder saved on the operator's way out. */
  'campaign.autosavedDraft': {
    pt: 'Rascunho guardado automaticamente',
    en: 'Autosaved draft',
  },
  'campaign.progress': { pt: '{done} de {total} enviadas', en: '{done} of {total} sent' },
  /**
   * Shown while every recipient is already attempted but the campaign record
   * still reads RUNNING — the asynchronous reconciliation that follows a run.
   */
  'campaign.finishing': {
    pt: 'A concluir — todas as mensagens foram enviadas',
    en: 'Finishing — every message has been sent',
  },
  'campaign.updated': { pt: 'Actualizado {when}', en: 'Updated {when}' },
  'campaign.funnel': { pt: 'Funil de entrega', en: 'Delivery funnel' },
  'campaign.funnelNote': {
    pt: 'Cada barra é uma percentagem dos destinatários da campanha.',
    en: 'Each bar is a share of the campaign’s recipients.',
  },
  'campaign.running': {
    pt: 'Uma campanha está a decorrer — os números actualizam sozinhos.',
    en: 'A campaign is running — the figures update by themselves.',
  },
  'campaign.col.name': { pt: 'Nome', en: 'Name' },
  'campaign.col.status': { pt: 'Estado', en: 'Status' },
  'campaign.col.created': { pt: 'Criada', en: 'Created' },
  'campaign.col.archived': { pt: 'Arquivada', en: 'Archived' },
  'campaign.col.phone': { pt: 'Telefone', en: 'Phone' },
  'campaign.col.reason': { pt: 'Motivo', en: 'Reason' },

  'campaign.step.basics': { pt: 'Básico', en: 'Basics' },
  'campaign.step.template': { pt: 'Modelo', en: 'Template' },
  'campaign.step.audience': { pt: 'Audiência', en: 'Audience' },
  'campaign.step.variables': { pt: 'Variáveis', en: 'Variables' },
  'campaign.step.review': { pt: 'Rever', en: 'Review' },
  'campaign.stepOf': { pt: 'Passo {step} de {total}', en: 'Step {step} of {total}' },

  'campaign.previewTitle': { pt: 'Como fica a mensagem', en: 'How the message reads' },
  /**
   * No braces in this one, deliberately. `{{marcador}}` and `{{placeholder}}`
   * are not the same token, and the parallel-placeholder test reads every
   * `{…}` in a string as an interpolation slot — so a sentence *about*
   * placeholders written with placeholders fails it, correctly.
   */
  'campaign.previewPlaceholders': {
    pt: 'As variáveis por preencher ficam à vista, entre chavetas duplas.',
    en: 'Unfilled variables stay visible, in double braces.',
  },
  'campaign.previewSample': {
    pt: 'Com os valores de {name}, um contacto real desta audiência.',
    en: 'With the values of {name}, a real contact from this audience.',
  },
  'campaign.previewUnavailable': {
    pt: 'Ainda não foi possível ler um contacto de exemplo desta audiência.',
    en: 'No sample contact could be read from this audience yet.',
  },
  'campaign.reviewMissing': {
    pt: '{count} de {total} contactos da amostra ficam sem variáveis e seriam excluídos: {keys}.',
    en: '{count} of {total} sampled contacts are missing variables and would be excluded: {keys}.',
  },
  'campaign.reviewNoMissing': {
    pt: 'Todos os contactos da amostra têm as variáveis preenchidas.',
    en: 'Every sampled contact has its variables filled.',
  },
  'campaign.reviewAudienceView': { pt: 'Vista “{name}”', en: 'View “{name}”' },
  'campaign.reviewAudienceManual': {
    pt: '{count} contactos escolhidos à mão',
    en: '{count} hand-picked contacts',
  },
  'campaign.reviewScheduleNow': { pt: 'Assim que for lançada', en: 'As soon as it is launched' },
  'campaign.reviewCountUnknown': {
    pt: 'O número exacto de destinatários, o custo e as exclusões saem da construção da audiência — aparecem no ecrã seguinte, antes de haver botão de lançamento.',
    en: 'The exact recipient count, the cost and the exclusions come out of the audience build — they appear on the next screen, before there is any launch button.',
  },
  'campaign.reviewWarnings': { pt: 'Avisos', en: 'Warnings' },
  'campaign.warnNotConnected': {
    pt: 'O número de envio não está ligado. A campanha não arranca assim.',
    en: 'The sending number is not connected. The campaign will not start like this.',
  },
  'campaign.warnQualityRed': {
    pt: 'A qualidade do número está em vermelho — o lançamento vai exigir uma confirmação explícita.',
    en: 'The number’s quality is red — launching will need an explicit acknowledgement.',
  },
  'campaign.warnQualityYellow': {
    pt: 'A qualidade do número está em amarelo. Vale rever o modelo antes de enviar a muita gente.',
    en: 'The number’s quality is yellow. Worth reviewing the template before sending to many people.',
  },
  'campaign.warnTestAccount': {
    pt: 'Este é um número de teste: a Meta só entrega a destinatários registados.',
    en: 'This is a test number: Meta only delivers to registered recipients.',
  },

  'campaign.name': { pt: 'Nome', en: 'Name' },
  'campaign.account': { pt: 'Número de envio', en: 'Sending number' },
  'campaign.schedule': { pt: 'Agendamento', en: 'Schedule' },
  'campaign.scheduleHint': {
    pt: 'Vazio envia assim que for lançada. A hora é a do seu navegador e é guardada em UTC.',
    en: 'Empty sends as soon as it is launched. The time is your browser’s and is stored in UTC.',
  },
  'campaign.templateHint': {
    pt: 'Só modelos aprovados e publicados. Os de autenticação não servem para campanhas.',
    en: 'Approved and published templates only. Authentication templates have no bulk use.',
  },
  'campaign.source': { pt: 'Origem', en: 'Source' },
  'campaign.sourceView': { pt: 'Vista guardada de Pessoas', en: 'Saved People view' },
  'campaign.sourceManual': {
    pt: 'Contactos escolhidos à mão',
    en: 'Hand-picked contacts',
  },
  'campaign.view': { pt: 'Vista', en: 'View' },
  // ─── The manual-audience contact picker (replaced the UUID textarea) ──────
  'campaign.personSearch': { pt: 'Procurar contactos', en: 'Search contacts' },
  'campaign.personSearchHint': {
    pt: 'Procure por nome ou por número de telefone e adicione um a um.',
    en: 'Search by name or phone number and add them one by one.',
  },
  'campaign.personSearchPlaceholder': {
    pt: 'Nome ou telefone…',
    en: 'Name or phone…',
  },
  'campaign.personNoResults': {
    pt: 'Nenhum contacto corresponde a “{query}”.',
    en: 'No contact matches “{query}”.',
  },
  'campaign.personSelected': {
    pt: 'Audiência ({count})',
    en: 'Audience ({count})',
  },
  'campaign.personRemove': { pt: 'Remover da audiência', en: 'Remove from audience' },
  'campaign.noVariables': {
    pt: 'Este modelo não tem variáveis.',
    en: 'This template has no variables.',
  },
  'campaign.bindingField': { pt: 'Campo do contacto', en: 'Contact field' },
  'campaign.bindingStatic': { pt: 'Texto fixo', en: 'Fixed text' },
  'campaign.field': { pt: 'Campo', en: 'Field' },
  'campaign.text': { pt: 'Texto', en: 'Text' },
  'campaign.fallback': { pt: 'Alternativa', en: 'Fallback' },
  'campaign.fallbackHint': {
    pt: 'Usada quando o campo está vazio. Sem alternativa, o contacto é excluído.',
    en: 'Used when the field is empty. Without one, the contact is excluded.',
  },
  'campaign.build': { pt: 'Construir audiência', en: 'Build audience' },
  'campaign.createdNoId': {
    pt: 'O servidor criou a campanha mas não devolveu o id.',
    en: 'The server created the campaign but returned no id.',
  },

  'campaign.numbers': { pt: 'Números', en: 'Figures' },
  'campaign.counter.recipientCount': { pt: 'Destinatários', en: 'Recipients' },
  'campaign.counter.queuedCount': { pt: 'Em fila', en: 'Queued' },
  'campaign.counter.sentCount': { pt: 'Enviadas', en: 'Sent' },
  'campaign.counter.deliveredCount': { pt: 'Entregues', en: 'Delivered' },
  'campaign.counter.readCount': { pt: 'Lidas', en: 'Read' },
  'campaign.counter.respondedCount': { pt: 'Respostas', en: 'Replies' },
  'campaign.counter.failedCount': { pt: 'Falhadas', en: 'Failed' },
  'campaign.counter.skippedCount': { pt: 'Ignoradas', en: 'Skipped' },
  'campaign.counter.excludedCount': { pt: 'Excluídas', en: 'Excluded' },
  'campaign.counter.actualCost': { pt: 'Custo real', en: 'Actual cost' },

  'campaign.launch': { pt: 'Lançar', en: 'Launch' },
  'campaign.pause': { pt: 'Pausar', en: 'Pause' },
  'campaign.resume': { pt: 'Retomar', en: 'Resume' },
  'campaign.cancel': { pt: 'Cancelar', en: 'Cancel' },
  'campaign.launchNeedsPreflight': {
    pt: 'A verificar destinatários e custo. O botão de lançamento aparece quando os números estiverem prontos.',
    en: 'Checking recipients and cost. The launch button appears once the numbers are ready.',
  },
  /**
   * Names the number that explains it. "No recipients" alone invites a rebuild
   * of an audience that is not the problem — the contacts were found and then
   * excluded, and the exclusion breakdown below says by what.
   */
  'campaign.launchNoRecipients': {
    pt: 'Nenhum destinatário qualificado: {excluded} excluídos. Corrija os motivos abaixo e reconstrua a audiência.',
    en: 'No recipient qualifies: {excluded} excluded. Fix the reasons below and rebuild the audience.',
  },
  // `{cost}` arrives from `money()` with its own currency sign.
  'campaign.launchSubtitle': {
    pt: '{count} destinatários, ~{cost}',
    en: '{count} recipients, ~{cost}',
  },
  'campaign.cancelSubtitle': {
    pt: 'As mensagens ainda não enviadas não serão enviadas.',
    en: 'Messages not yet sent will not be sent.',
  },
  'campaign.delete': { pt: 'Eliminar campanha', en: 'Delete campaign' },
  'campaign.deleteSubtitle': {
    pt: 'A campanha e a audiência que foi construída desaparecem da lista. Não há nada enviado para perder.',
    en: 'The campaign and the audience it built come off the list. There is nothing sent to lose.',
  },
  'campaign.deleteNote': {
    pt: 'Esta campanha nunca foi lançada, por isso ainda pode ser eliminada. Depois do lançamento passa a ser o registo do que foi enviado — a partir daí só pode ser cancelada, nunca eliminada.',
    en: 'This campaign was never launched, so it can still be deleted. Once launched it becomes the record of what went out — from then on it can only be cancelled, never deleted.',
  },
  'campaign.archive': { pt: 'Arquivar', en: 'Archive' },
  'campaign.unarchive': { pt: 'Desarquivar', en: 'Unarchive' },
  'campaign.archiveTitle': { pt: 'Arquivo', en: 'Archive' },
  'campaign.archivedOn': {
    pt: 'Arquivada {when} — está fora da lista de campanhas, mas continua a receber estados de entrega e respostas.',
    en: 'Archived {when} — off the campaigns list, but still receiving delivery statuses and replies.',
  },
  'campaign.archiveNone': { pt: 'O arquivo está vazio.', en: 'The archive is empty.' },
  'campaign.archiveNoneBody': {
    pt: 'As campanhas concluídas, canceladas ou falhadas podem ser arquivadas a partir da própria campanha. Nada é apagado: sai da lista e volta quando quiser.',
    en: 'Completed, cancelled or failed campaigns can be archived from the campaign itself. Nothing is deleted: it leaves the list and comes back whenever you want.',
  },
  'campaign.archiveBack': { pt: 'Voltar às campanhas', en: 'Back to campaigns' },
  'campaign.reason': { pt: 'Motivo', en: 'Reason' },
  'campaign.pacing': {
    pt: 'O ritmo foi reduzido para respeitar o limite do número — a campanha demora mais do que o previsto, e nada foi perdido.',
    en: 'The pace was reduced to respect the number’s limit — the campaign takes longer than planned, and nothing was lost.',
  },

  'campaign.preflightAudience': { pt: 'Pré-voo — audiência', en: 'Pre-flight — audience' },
  'campaign.preflightCost': { pt: 'Pré-voo — custo e limite', en: 'Pre-flight — cost and limit' },
  'campaign.preflightQuality': {
    pt: 'Pré-voo — qualidade e modelo',
    en: 'Pre-flight — quality and template',
  },
  'campaign.preflightPreview': { pt: 'Pré-voo — como fica', en: 'Pre-flight — how it reads' },
  'campaign.willReceive': { pt: 'Vão receber', en: 'Will receive' },
  'campaign.excluded': { pt: 'Excluídos', en: 'Excluded' },
  // Both values arrive from `money()` with their own currency sign.
  'campaign.perMessage': {
    pt: '~{total} a {rate} por mensagem',
    en: '~{total} at {rate} per message',
  },
  'campaign.tierLine': {
    pt: 'Escalão {tier}: {used} usados de {limit}, {reserve} reservados para conversas 1:1 — {available} disponíveis hoje.',
    en: 'Tier {tier}: {used} used of {limit}, {reserve} reserved for 1:1 conversations — {available} available today.',
  },
  'campaign.spreadFits': { pt: 'Cabe tudo no dia de hoje.', en: 'It all fits in today.' },
  'campaign.spreadDays': {
    pt: '{firstDay} hoje, e o resto ao longo de {days} dias — o escalão diário não chega para a audiência toda.',
    en: '{firstDay} today, and the rest over {days} days — the daily tier does not cover the whole audience.',
  },
  'campaign.quality': { pt: 'Qualidade', en: 'Quality' },
  'campaign.acknowledge': {
    pt: 'Reconheço a classificação e quero lançar mesmo assim',
    en: 'I acknowledge the rating and want to launch anyway',
  },
  'campaign.launchAnyway': { pt: 'Lançar mesmo assim', en: 'Launch anyway' },
  'campaign.testSend': { pt: 'Envio de teste', en: 'Test send' },
  'campaign.recipientsSample': {
    pt: 'Destinatários (amostra de {count})',
    en: 'Recipients (sample of {count})',
  },

  // ─── Settings ─────────────────────────────────────────────────────────────
  'settings.tab.connection': { pt: 'Ligação', en: 'Connection' },
  'settings.tab.health': { pt: 'Saúde', en: 'Health' },
  'settings.tab.templates': { pt: 'Modelos', en: 'Templates' },
  'settings.tab.variables': { pt: 'Variáveis', en: 'Variables' },
  'settings.tab.diagnostics': { pt: 'Diagnóstico', en: 'Diagnostics' },
  'settings.variablesNote': {
    pt: 'Definições da aplicação. As palavras-chave e o texto das confirmações estão aqui de propósito: mudá-los é uma edição, nunca um deploy.',
    en: 'Application settings. The keywords and the confirmation wording live here on purpose: changing them is an edit, never a deploy.',
  },
  'settings.variableSaved': { pt: '{key} guardada', en: '{key} saved' },
  'settings.variableEdited': { pt: 'alterada', en: 'edited' },
  /**
   * The bar lists the keys beside this count. A single Save that commits a
   * throttle and a legal sentence together is only acceptable if the operator
   * can see that is what it is about to do (D-68).
   */
  'settings.unsavedChanges': {
    pt: '{count} alteração(ões) por guardar',
    en: '{count} unsaved change(s)',
  },
  'settings.saveChanges': { pt: 'Guardar {count}', en: 'Save {count}' },
  // The sections the variables are grouped into, named by what they affect.
  'settings.variableSection.connection': { pt: 'Ligação à Meta', en: 'Meta connection' },
  'settings.variableSection.sending': { pt: 'Envio e ritmo', en: 'Sending and pacing' },
  'settings.variableSection.window': {
    pt: 'Janela de serviço',
    en: 'Service window',
  },
  'settings.variableSection.consent': {
    pt: 'Consentimento e confirmações',
    en: 'Consent and confirmations',
  },
  'settings.variableSection.campaigns': { pt: 'Campanhas', en: 'Campaigns' },
  'settings.variableSection.templates': { pt: 'Modelos', en: 'Templates' },
  'settings.variableSection.media': { pt: 'Ficheiros', en: 'Media' },
  'settings.variableSection.retention': {
    pt: 'Retenção e cronologia',
    en: 'Retention and timeline',
  },
  'settings.variableSection.billing': { pt: 'Tarifas', en: 'Rates' },
  'settings.variableSection.interface': { pt: 'Interface', en: 'Interface' },
  'settings.variableSection.access': { pt: 'Acessos', en: 'Access' },
  'settings.variableSection.other': { pt: 'Outras', en: 'Other' },

  'settings.summary': {
    pt: '{displayName} · qualidade {quality} · escalão {tier}',
    en: '{displayName} · quality {quality} · tier {tier}',
  },
  'settings.test': { pt: 'Testar ligação', en: 'Test connection' },
  'settings.tested': { pt: 'Ligação testada.', en: 'Connection tested.' },
  'settings.syncTemplates': { pt: 'Sincronizar modelos', en: 'Sync templates' },
  'settings.syncRequested': { pt: 'Sincronização pedida.', en: 'Sync requested.' },
  'settings.saved': { pt: 'Guardado.', en: 'Saved.' },
  'settings.disconnect': { pt: 'Desligar', en: 'Disconnect' },
  'settings.dangerZone': { pt: 'Zona de perigo', en: 'Danger zone' },
  'settings.disconnectWarning': {
    pt: 'Desligar este número pára o envio e a recepção de mensagens WhatsApp neste espaço de trabalho até que volte a ser ligado.',
    en: 'Disconnecting this number stops sending and receiving WhatsApp messages in this workspace until it is connected again.',
  },
  'settings.disconnectConfirm': {
    pt: 'Confirmar e desligar',
    en: 'Confirm disconnect',
  },
  'settings.connectTitle': { pt: 'Ligar um número', en: 'Connect a number' },
  'settings.connect': { pt: 'Ligar', en: 'Connect' },
  'settings.name': { pt: 'Nome', en: 'Name' },
  'settings.phoneNumberIdHint': {
    pt: 'Meta → WhatsApp → API Setup.',
    en: 'Meta → WhatsApp → API Setup.',
  },
  'settings.callingCode': { pt: 'Indicativo por omissão', en: 'Default calling code' },
  /**
   * The field sits under `phone_number_id` and `WABA id`, both of which take
   * long numbers, and operators pasted the whole display number into it. The
   * counter-example is doing the work here — "1-3 digits" alone did not stop
   * anyone.
   */
  'settings.callingCodeHint': {
    pt: 'Só o indicativo do país (1 a 3 dígitos), p. ex. +244 — não o número completo.',
    en: 'The country code only (1–3 digits), e.g. +244 — not the full phone number.',
  },
  'settings.callingCodeInherited': {
    pt: 'herda WA_DEFAULT_COUNTRY_CALLING_CODE',
    en: 'inherits WA_DEFAULT_COUNTRY_CALLING_CODE',
  },
  'settings.isTestAccount': { pt: 'É um número de teste', en: 'This is a test number' },

  'settings.callback': { pt: 'Callback da Meta', en: 'Meta callback' },
  'settings.callbackUrl': {
    pt: 'URL do callback (alias no proxy)',
    en: 'Callback URL (proxy alias)',
  },
  /**
   * The sentence that was missing, and the whole of issue #1.
   *
   * The Meta dashboard takes **one** URL and uses it for both the GET
   * handshake and the POST deliveries; Twenty answers those on two different
   * paths. The alias is the only thing that makes one URL out of two, and an
   * operator who does not know it has to exist will paste it, watch
   * verification fail, and have nothing to go on.
   */
  /**
   * The seven steps, in the order they must happen, each named after the
   * failure it prevents.
   *
   * They exist because every one of them was found the hard way on a real
   * install (issue #1 and the 0.1.1 rollout): each has a distinct status code,
   * none of them is guessable, and the first three produce a webhook that is
   * *configured correctly in Meta* and still delivers nothing. An operator who
   * reads only the callback URL gets none of this.
   */
  'settings.callbackSteps': { pt: 'Configuração, por ordem', en: 'Setup, in order' },
  'settings.callbackStep1': {
    pt: '1. Reclame a aplicação. Em Definições → Aplicações → esta app → Zona de perigo, clique em “Reclamar propriedade”. A rota POST é uma rota de servidor e corre na área de trabalho dona da aplicação: sem dona, não existe (404).',
    en: '1. Claim the app. In Settings → Applications → this app → Danger zone, click “Claim ownership”. The POST route is a server route and runs in the app-owner workspace: with no owner it does not exist (404).',
  },
  'settings.callbackStep2': {
    pt: '2. Ligue as funções lógicas no servidor. Defina LOGIC_FUNCTION_TYPE=LOCAL (ou LAMBDA) no ambiente do servidor Twenty e reinicie. Sem isto nada nesta app corre — nem rotas, nem tarefas agendadas (403).',
    en: '2. Enable logic functions on the server. Set LOGIC_FUNCTION_TYPE=LOCAL (or LAMBDA) in the Twenty server environment and restart. Without it nothing in this app runs — not routes, not scheduled jobs (403).',
  },
  'settings.callbackStep3': {
    pt: '3. Defina as quatro variáveis META_* no separador Variáveis. O resolvedor falha fechado sem elas: recusa-se a verificar assinaturas contra uma chave vazia (500).',
    en: '3. Set the four META_* variables in the Variables tab. The resolver fails closed without them: it refuses to verify signatures against an empty key (500).',
  },
  'settings.callbackStep4': {
    pt: '4. Crie o alias no proxy. Encaminhe um caminho público por método: GET para o URL de verificação, POST para a forma directa — ambos em baixo. O proxy não pode reescrever nem recodificar o corpo do pedido: a assinatura é sobre os bytes exactos.',
    en: '4. Add the proxy alias. Route one public path by method: GET to the Verification URL, POST to the Direct form — both below. The proxy must not rewrite or re-encode the request body: the signature is over the exact bytes.',
  },
  /**
   * The failure with no trace, and the reason it gets its own step: bot
   * protection at the edge swallows the delivery before the server sees it, so
   * every log here stays empty and every manual test passes. Diagnosed on a
   * live install where Cloudflare's AI Labyrinth was serving Meta decoy pages.
   */
  'settings.callbackStep5': {
    pt: '5. Desligue a protecção contra bots neste anfitrião. O AI Labyrinth e o Bot Fight Mode da Cloudflare tratam as entregas da Meta como tráfego de robôs e servem-lhes conteúdo falso — não chega nada ao servidor e não fica registo nenhum. Veja Segurança → Eventos, à procura de “AI Labyrinth Served”.',
    en: '5. Turn off bot protection for this host. Cloudflare’s AI Labyrinth and Bot Fight Mode treat Meta’s deliveries as crawler traffic and serve them decoy content — nothing reaches the server and nothing is logged anywhere. Check Security → Events for “AI Labyrinth Served”.',
  },
  'settings.callbackStep6': {
    pt: '6. Na Meta → WhatsApp → Configuração → Webhooks, cole o URL do callback em baixo e o seu META_VERIFY_TOKEN, e clique em Verificar e guardar.',
    en: '6. In Meta → WhatsApp → Configuration → Webhooks, paste the Callback URL below and your META_VERIFY_TOKEN, then click Verify and save.',
  },
  'settings.callbackStep7': {
    pt: '7. Subscreva todos os campos listados em baixo. Sem message_template_status_update, as aprovações de modelos nunca chegam.',
    en: '7. Subscribe every field listed below. Without message_template_status_update, template approvals never arrive.',
  },
  /**
   * The step that explains an empty table. Meta's sample payload carries a
   * phone_number_id nobody owns, so the resolver answers 200 and discards it —
   * correctly, since a non-2xx would earn a week of retries for a number we do
   * not host. Without this sentence that reads exactly like a broken webhook.
   */
  'settings.callbackStep8': {
    pt: '8. Ligue primeiro o seu número, depois teste. O “Send to my server” da Meta usa um número de exemplo que ninguém reclamou: é aceite (200) e descartado, sem deixar linha nenhuma. Só depois de ligar o seu número é que um teste aparece no Diagnóstico.',
    en: '8. Connect your number first, then test. Meta’s “Send to my server” uses a sample number nobody has claimed: it is accepted (200) and discarded, leaving no row at all. Only once your number is connected does a test show up in Diagnostics.',
  },
  'settings.callbackProxyNote': {
    pt: 'A Meta usa um só URL para o GET de verificação e para os POST de eventos; o Twenty responde-lhes em caminhos diferentes. O URL do callback só funciona depois de criar esta regra no seu proxy: GET → URL de verificação, POST → forma directa. Sem essa regra, aponte a Meta directamente à forma directa (se a sua instância encaminhar GET para rotas de servidor) e verifique pelo URL de verificação.',
    en: 'Meta uses a single URL for both the GET verification and the POST events; Twenty answers those on different paths. The callback URL only works once you add this rule to your proxy: GET → verification URL, POST → direct form. Without that rule, point Meta straight at the direct form (if your instance routes GET to server routes) and verify at the verification URL.',
  },
  /**
   * Shown only when the server's own address is local. The path is
   * interpolated rather than written out so the sentence cannot drift from the
   * URL printed under it.
   */
  'settings.callbackLocalNote': {
    pt: 'Estes endereços são locais desta máquina — a Meta não os consegue alcançar. No Meta, use o URL público do seu túnel (ngrok, cloudflared, …) com o mesmo caminho {path}.',
    en: 'These addresses are local to this machine — Meta cannot reach them. In Meta, use your public tunnel URL (ngrok, cloudflared, …) with the same {path} path.',
  },
  'settings.directUrl': { pt: 'Forma directa (POST)', en: 'Direct form (POST)' },
  'settings.verifyUrl': { pt: 'URL de verificação (GET)', en: 'Verification URL (GET)' },
  'settings.verifyToken': { pt: 'Token de verificação', en: 'Verify token' },
  'settings.verifyTokenSet': {
    pt: 'configurado na variável de servidor META_VERIFY_TOKEN',
    en: 'configured in the META_VERIFY_TOKEN server variable',
  },
  /**
   * The warning mark used to live in the string. It is an icon in the
   * component now, so the sentence is only a sentence — a translator changing
   * the wording can no longer delete the alert by accident.
   */
  'settings.verifyTokenMissing': {
    pt: 'em falta — defina META_VERIFY_TOKEN',
    en: 'missing — set META_VERIFY_TOKEN',
  },
  'settings.requiredFields': { pt: 'Campos a subscrever', en: 'Fields to subscribe' },
  'settings.copyFields': { pt: 'Copiar lista de campos', en: 'Copy the field list' },

  'settings.health.token': { pt: 'Token de acesso', en: 'Access token' },
  'settings.health.token.remedy': {
    pt: 'A verificação horária não corre há mais de duas horas, ou falhou. Veja specs/11 §2.',
    en: 'The hourly check has not run for over two hours, or it failed. See specs/11 §2.',
  },
  'settings.health.webhook': { pt: 'Webhook', en: 'Webhook' },
  'settings.health.webhook.remedy': {
    pt: 'Não chegam eventos há mais tempo do que o limite. Confirme a subscrição na Meta.',
    en: 'No events for longer than the threshold. Check the subscription at Meta.',
  },
  'settings.health.quality': { pt: 'Qualidade do número', en: 'Number quality' },
  'settings.health.quality.remedy': {
    pt: 'A Meta baixou a classificação. Reduza envios de marketing e reveja os modelos.',
    en: 'Meta lowered the rating. Cut marketing sends and review the templates.',
  },
  'settings.health.tier': { pt: 'Escalão diário', en: 'Daily tier' },
  'settings.health.tier.remedy': {
    pt: 'A reserva para conversas 1:1 já consumiu o que resta — nenhuma campanha arranca hoje.',
    en: 'The 1:1 reserve has taken what is left — no campaign starts today.',
  },
  'settings.health.failedWebhookEvents': {
    pt: 'Entregas falhadas (24h)',
    en: 'Failed deliveries (24h)',
  },
  'settings.health.failedWebhookEvents.remedy': {
    pt: 'Há eventos por processar. Veja o separador Diagnóstico.',
    en: 'There are unprocessed events. See the Diagnostics tab.',
  },
  'settings.templateQuality': { pt: 'Qualidade {score}', en: 'Quality {score}' },
  'settings.health.detail.tokenNever': {
    pt: 'Nunca verificado',
    en: 'Never checked',
  },
  'settings.health.detail.tokenChecked': {
    pt: 'Verificado {when}',
    en: 'Checked {when}',
  },
  'settings.health.detail.webhookNone': {
    pt: 'Ainda sem eventos recebidos',
    en: 'No events received yet',
  },
  'settings.health.detail.webhookLast': {
    pt: 'Último evento {when}',
    en: 'Last event {when}',
  },
  'settings.health.detail.quality': {
    pt: 'Classificação {rating}',
    en: 'Rated {rating}',
  },
  /** `UNKNOWN` means "no data yet". Saying "Rated UNKNOWN" invents a grade. */
  'settings.health.detail.qualityUngraded': {
    pt: 'A Meta ainda não classificou este número.',
    en: 'Meta has not rated this number yet.',
  },
  'settings.health.detail.tier': {
    pt: '{available} envios disponíveis hoje de {limit}, com {reserve} reservados para conversas 1:1',
    en: '{available} sends available today of {limit}, with {reserve} held back for 1:1 conversations',
  },
  'settings.health.detail.none': { pt: 'Nenhuma', en: 'None' },
  'settings.health.detail.count': { pt: '{count}', en: '{count}' },
  'settings.health.detail.stuck': {
    pt: '{count} há mais de {minutes} minutos',
    en: '{count} for more than {minutes} minutes',
  },
  'settings.health.stuckOutbound': { pt: 'Mensagens presas', en: 'Stuck messages' },
  'settings.health.stuckOutbound.remedy': {
    pt: 'Mensagens em fila há mais de 15 minutos. A verificação horária volta a tentar.',
    en: 'Messages queued for over 15 minutes. The hourly check retries them.',
  },
  'settings.health.failedOutbound': { pt: 'Envios falhados (24h)', en: 'Failed sends (24h)' },
  'settings.health.failedOutbound.remedy': {
    pt: 'Mensagens que não chegaram ao destinatário. O motivo de cada uma está no separador Diagnóstico.',
    en: 'Messages that never reached the recipient. Each one’s reason is in the Diagnostics tab.',
  },
  'settings.health.webhookRoute': {
    pt: 'Rota do webhook (POST)',
    en: 'Webhook route (POST)',
  },
  /**
   * The remedy names the claim, because that is the cause in every case seen
   * so far and it is not a step anyone would guess: the app installs, the
   * functions register, and only the server route silently has nowhere to run.
   */
  'settings.health.webhookRoute.remedy': {
    pt: 'O servidor não tem esta rota. Quase sempre é o registo da aplicação por reclamar: em Definições → Aplicações, reclame a propriedade da app. Uma rota de servidor corre na área de trabalho dona da aplicação e, sem dona, não existe.',
    en: 'The server has no such route. Almost always the application registration is unclaimed: in Settings → Applications, claim ownership of the app. A server route runs in the app-owner workspace, and without an owner it does not exist.',
  },
  'settings.health.detail.webhookRouteLive': {
    pt: 'A rota responde e a assinatura foi aceite.',
    en: 'The route answers and the signature was accepted.',
  },
  'settings.health.detail.webhookRouteLiveUnsigned': {
    pt: 'A rota responde. Defina META_APP_SECRET para confirmar também a assinatura.',
    en: 'The route answers. Set META_APP_SECRET to confirm the signature too.',
  },
  'settings.health.detail.webhookRouteMissing': {
    pt: 'O servidor respondeu 404 — não existe rota de servidor para esta app.',
    en: 'The server answered 404 — there is no server route for this app.',
  },
  'settings.health.detail.webhookRouteDisabled': {
    pt: 'O servidor recusa executar funções lógicas — nada nesta app funciona. Defina LOGIC_FUNCTION_TYPE=LOCAL (ou LAMBDA) no ambiente do servidor Twenty e reinicie.',
    en: 'The server refuses to run logic functions — nothing in this app works. Set LOGIC_FUNCTION_TYPE=LOCAL (or LAMBDA) in the Twenty server environment and restart.',
  },
  'settings.health.detail.webhookRouteSecret': {
    pt: 'A rota recusou uma assinatura gerada por esta app: META_APP_SECRET não corresponde ao segredo da app na Meta.',
    en: 'The route rejected a signature this app generated: META_APP_SECRET does not match the app secret in Meta.',
  },
  'settings.health.detail.webhookRouteErrored': {
    pt: 'A rota existe mas rebentou ({status}). Num arranque novo é quase sempre META_APP_SECRET por definir — o resolvedor recusa-se a verificar assinaturas com uma chave vazia. Veja os registos da função.',
    en: 'The route exists but threw ({status}). On a fresh install this is almost always META_APP_SECRET being unset — the resolver refuses to verify signatures against an empty key. Check the function logs.',
  },
  'settings.health.detail.webhookRouteUnreachable': {
    pt: 'Não foi possível contactar a rota a partir do servidor.',
    en: 'The route could not be reached from the server.',
  },
  'settings.health.detail.webhookRouteUnknown': {
    pt: 'A rota respondeu {status}, que não sabemos ler.',
    en: 'The route answered {status}, which we have no reading for.',
  },
  'settings.health.consentWording': {
    pt: 'Textos de consentimento',
    en: 'Consent wording',
  },
  'settings.health.consentWording.remedy': {
    pt: 'A confirmação manda o contacto responder uma palavra que já não está na lista de palavras-chave. Reponha a palavra na lista, ou use {optOutKeyword} / {optInKeyword} no texto para que acompanhe sempre a lista.',
    en: 'The confirmation tells the contact to reply a word that is no longer in the keyword list. Put the word back, or use {optOutKeyword} / {optInKeyword} in the text so it always follows the list.',
  },
  'settings.health.detail.consentWordingOk': {
    pt: 'As confirmações e as listas de palavras-chave concordam.',
    en: 'The confirmations and the keyword lists agree.',
  },
  'settings.health.detail.consentWording': {
    pt: 'Já não é reconhecida: {words}',
    en: 'No longer recognised: {words}',
  },
  'settings.needsAdminRole': {
    pt: 'Precisa da função de administrador do WhatsApp para alterar seja o que for nesta página. Pode ler; as acções estão desactivadas.',
    en: 'Changing anything on this page needs the WhatsApp admin role. You can read it; the actions are disabled.',
  },
  'settings.ok': { pt: 'OK', en: 'OK' },
  'settings.needsAttention': { pt: 'a precisar de atenção', en: 'needs attention' },

  'settings.noTemplates': {
    pt: 'Nenhum modelo sincronizado.',
    en: 'No templates synced.',
  },
  'settings.publish': { pt: 'Publicar', en: 'Publish' },
  'settings.unpublish': { pt: 'Despublicar', en: 'Unpublish' },
  'settings.published': { pt: 'Publicado', en: 'Published' },
  'settings.notPublished': { pt: 'Não publicado', en: 'Not published' },
  'settings.templateFilter.all': { pt: 'Todos', en: 'All' },
  'settings.templateFilter.published': { pt: 'Publicados', en: 'Published' },
  'settings.templateFilter.unpublished': { pt: 'Por publicar', en: 'Unpublished' },

  'settings.failedEvents': { pt: 'Entregas falhadas (24h)', en: 'Failed deliveries (24h)' },
  'settings.stuckMessages': { pt: 'Mensagens presas', en: 'Stuck messages' },
  /**
   * Distinct from "Entregas falhadas", which is *inbound* — webhook events we
   * could not process. A rep reporting "my photo did not send" is asking about
   * this list, and until D-65 there was no list to look at.
   */
  'settings.failedOutbound': {
    pt: 'Envios falhados (24h)',
    en: 'Failed sends (24h)',
  },
  'settings.attempts': { pt: 'tentativas', en: 'attempts' },
  'settings.replay': { pt: 'Reprocessar', en: 'Replay' },
  'settings.replaySelected': {
    pt: 'Reprocessar seleccionadas ({count})',
    en: 'Replay selected ({count})',
  },
  'settings.replayAllFailed': {
    pt: 'Reprocessar todas as falhadas',
    en: 'Replay all failed',
  },
  'settings.replayConfirm': {
    pt: 'Reprocessar {count} entregas? É seguro repetir: cada processador é idempotente pelo WAMID.',
    en: 'Replay {count} deliveries? Repeating is safe: every processor is idempotent on the WAMID.',
  },
  'settings.replayDone': {
    pt: '{replayed} de {requested} reprocessadas, {jobs} tarefas na fila.',
    en: '{replayed} of {requested} replayed, {jobs} jobs queued.',
  },
  'settings.replayTruncated': {
    pt: 'Ainda faltam entregas: o limite por pedido é {cap}. Volte a carregar para continuar.',
    en: 'Deliveries are left over: the per-request cap is {cap}. Press again to continue.',
  },
  'settings.replayNothing': {
    pt: 'Nenhuma entrega falhada para reprocessar.',
    en: 'No failed delivery to replay.',
  },
  'settings.replayNote': {
    pt: 'A Meta reenvia um webhook durante 7 dias e não tem endpoint de reposição, por isso este registo é a única origem para reprocessar. Reprocessar é seguro: nada é duplicado.',
    en: 'Meta retries a webhook for 7 days and offers no replay endpoint, so this log is the only source for reprocessing. Replaying is safe: nothing is duplicated.',
  },
  'settings.notifications': { pt: 'Notificações', en: 'Notifications' },
  'settings.notificationsNote': {
    pt: 'As mensagens por ler e o aviso ao vivo chegam a quem está a olhar para o Twenty. Para chegar a quem não está, é preciso um fluxo de trabalho: este botão cria-o em rascunho, com o gatilho já ligado a uma mensagem nova de WhatsApp.',
    en: 'Unread counts and the live toast reach whoever is looking at Twenty. Reaching someone who is not takes a workflow: this button creates one as a draft, with the trigger already wired to a new WhatsApp message.',
  },
  'settings.createNotificationWorkflow': {
    pt: 'Criar o fluxo de notificação',
    en: 'Create the notification workflow',
  },
  'settings.notificationWorkflowCreated': {
    pt: 'Rascunho criado: “{name}”. Abra-o em Fluxos de trabalho para o rever e activar.',
    en: 'Draft created: “{name}”. Open it under Workflows to review and activate it.',
  },
  'settings.notificationWorkflowExisted': {
    pt: 'Já existe: “{name}”. Nada foi alterado.',
    en: 'It already exists: “{name}”. Nothing was changed.',
  },
  'settings.review.FILTER_INBOUND': {
    pt: 'Filtre o gatilho por direcção = INBOUND — sem isso, cada mensagem que um agente envia cria uma tarefa a pedir-lhe que responda a si próprio.',
    en: 'Filter the trigger to direction = INBOUND — without it, every message a rep sends creates a task asking them to reply to themselves.',
  },
  'settings.review.CHOOSE_ASSIGNEE': {
    pt: 'Escolha quem recebe a tarefa: o responsável da conversa, ou uma pessoa fixa.',
    en: 'Choose who gets the task: the conversation’s assignee, or a fixed person.',
  },
  'settings.review.ACTIVATE': {
    pt: 'Active o fluxo. Fica em rascunho até o fazer.',
    en: 'Activate the workflow. It stays a draft until you do.',
  },
  'settings.consent': { pt: 'Consentimento', en: 'Consent' },
  'settings.consentNote': {
    pt: 'As palavras-chave de subscrição e cancelamento, e o texto da confirmação, são variáveis da aplicação — edite-as no separador Variáveis, aqui ao lado. Não são código de propósito: o texto é revisto por aconselhamento jurídico e uma alteração não deve exigir um deploy.',
    en: 'The opt-in and opt-out keywords, and the confirmation wording, are application variables — edit them in the Variables tab, next to this one. They are deliberately not code: the wording is reviewed by counsel, and a change must never require a deploy.',
  },
} satisfies Record<string, Entry>;

export type CopyKey = keyof typeof COPY;

type Table = Record<string, string>;

const tableFor = (lang: Lang): Table =>
  Object.fromEntries(Object.entries(COPY).map(([key, entry]) => [key, entry[lang]]));

export const TABLES: Record<Lang, Table> = { pt: tableFor('pt'), en: tableFor('en') };

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * A missing key renders as the key itself rather than as an empty string.
 *
 * Silence is the worst possible failure for copy: a blank denial reads as "you
 * may send" and a blank error reads as "nothing went wrong". `policy.FOO` on
 * screen is ugly and unmistakable, which is the right trade for a string that
 * was forgotten. There is no cross-language fallback, because paired entries
 * make a half-translated key impossible — an unknown key is unknown in both.
 */
export const translateWith =
  (lang: Lang): Translate =>
  (key, values) => {
    const template = TABLES[lang][key] ?? key;

    if (values === undefined) return template;

    return Object.entries(values).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      template,
    );
  };

export const useCopy = (): { t: Translate; lang: Lang } => {
  const locale = useLocale();
  const lang = langOf(locale);

  return { t: useCallback(translateWith(lang), [lang]), lang };
};

/**
 * The sentence under a failed bubble.
 *
 * Falls back to the uncatalogued line rather than showing Meta's raw English —
 * which is written for a developer reading an API response, not for a rep
 * looking at a conversation.
 */
export const errorCopy = (
  t: Translate,
  errorCode: string | null,
  errorDetail: string | null,
): string => {
  if (errorCode === null) return errorDetail ?? t('error.unknown');

  return Object.prototype.hasOwnProperty.call(COPY, `error.${errorCode}`)
    ? /**
       * `detail` is offered to every entry and consumed by the one that names
       * it. A code whose sentence has no `{detail}` is unchanged, so this
       * cannot leak Meta's developer English into copy that deliberately
       * replaces it.
       */
      t(`error.${errorCode}`, { detail: errorDetail ?? '—' })
    : t('error.unknown');
};

/**
 * The sentence for a send the *route* refused, which is a different problem
 * from a send Meta refused.
 *
 * `errorCopy` answers "uncatalogued error" for anything it does not recognise,
 * which is right under a bubble — Meta's raw English helps nobody there. Here
 * the unrecognised value is usually a plain server sentence about this
 * workspace, and replacing it with "uncatalogued error" is how a rep ends up
 * with no idea which address to fix (D-58).
 */
export const refusalCopy = (
  t: Translate,
  code: string,
  detail: string | null | undefined,
): string => {
  if (Object.prototype.hasOwnProperty.call(COPY, `error.${code}`)) {
    return t(`error.${code}`, { detail: detail ?? '—' });
  }

  return typeof detail === 'string' && detail.length > 0 ? `${code}: ${detail}` : code;
};
