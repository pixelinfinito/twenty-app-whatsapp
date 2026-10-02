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
 * **The languages are written side by side, not in parallel tables.** Separate
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

export type Lang = 'pt' | 'en' | 'es';

export const langOf = (locale: string | null | undefined): Lang => {
  const normalised = typeof locale === 'string' ? locale.toLowerCase() : '';

  if (normalised.startsWith('pt')) return 'pt';
  if (normalised.startsWith('es')) return 'es';

  return 'en';
};

type Entry = { pt: string; en: string; es: string };

const COPY = {
  // ─── Policy denials — the composer's disabled states (specs/08 §3.3) ──────
  'policy.ACCOUNT_NOT_CONNECTED': {
    pt: 'O número de WhatsApp não está ligado.',
    en: 'The WhatsApp number is not connected.',
    es: 'El número de WhatsApp no está conectado.',
  },
  'policy.THREAD_BLOCKED': {
    pt: 'Esta conversa está bloqueada.',
    en: 'This conversation is blocked.',
    es: 'Esta conversación está bloqueada.',
  },
  'policy.OPTED_OUT': {
    pt: 'Este contacto cancelou a subscrição.',
    en: 'This contact has unsubscribed.',
    es: 'Este contacto canceló la suscripción.',
  },
  'policy.NO_CONSENT': {
    pt: 'Este contacto não deu consentimento para marketing.',
    en: 'This contact has not consented to marketing.',
    es: 'Este contacto no dio su consentimiento para marketing.',
  },
  'policy.WINDOW_CLOSED': {
    pt: 'A janela de 24 horas fechou. Só pode enviar um modelo aprovado.',
    en: 'The 24-hour window has closed. Only an approved template can be sent.',
    es: 'La ventana de 24 horas se cerró. Solo puedes enviar una plantilla aprobada.',
  },
  'policy.TEMPLATE_UNAVAILABLE': {
    pt: 'Este modelo não está disponível para envio.',
    en: 'This template is not available to send.',
    es: 'Esta plantilla no está disponible para enviarse.',
  },
  'policy.QUALITY_RED': {
    pt: 'A qualidade do número está em vermelho.',
    en: 'The number’s quality rating is red.',
    es: 'La calidad del número está en rojo.',
  },

  'warning.WINDOW_EXPIRING_SOON': {
    pt: 'A janela fecha em breve.',
    en: 'The window closes soon.',
    es: 'La ventana se cierra pronto.',
  },
  'warning.CONSENT_UNKNOWN_MARKETING': {
    pt: 'Sem consentimento registado para marketing.',
    en: 'No recorded marketing consent.',
    es: 'Sin consentimiento registrado para marketing.',
  },
  'warning.QUALITY_YELLOW': {
    pt: 'A qualidade do número está em amarelo.',
    en: 'The number’s quality rating is yellow.',
    es: 'La calidad del número está en amarillo.',
  },

  // ─── Record states ────────────────────────────────────────────────────────
  'status.QUEUED': {
    pt: 'Em fila',
    en: 'Queued',
    es: 'En cola',
  },
  'status.ACCEPTED': {
    pt: 'Aceite',
    en: 'Accepted',
    es: 'Aceptada',
  },
  'status.SENT': {
    pt: 'Enviada',
    en: 'Sent',
    es: 'Enviada',
  },
  'status.DELIVERED': {
    pt: 'Entregue',
    en: 'Delivered',
    es: 'Entregada',
  },
  'status.READ': {
    pt: 'Lida',
    en: 'Read',
    es: 'Leída',
  },
  'status.PLAYED': {
    pt: 'Ouvida',
    en: 'Played',
    es: 'Reproducida',
  },
  'status.FAILED': {
    pt: 'Falhou',
    en: 'Failed',
    es: 'Fallida',
  },

  'thread.OPEN': {
    pt: 'Aberta',
    en: 'Open',
    es: 'Abierta',
  },
  'thread.AWAITING_REPLY': {
    pt: 'À espera de resposta',
    en: 'Awaiting reply',
    es: 'Esperando respuesta',
  },
  'thread.CLOSED': {
    pt: 'Fechada',
    en: 'Closed',
    es: 'Cerrada',
  },
  'thread.NEEDS_REVIEW': {
    pt: 'Por identificar',
    en: 'Unidentified',
    es: 'Sin identificar',
  },

  'consent.OPTED_IN': {
    pt: 'Subscrito',
    en: 'Subscribed',
    es: 'Suscrito',
  },
  'consent.OPTED_OUT': {
    pt: 'Cancelou',
    en: 'Unsubscribed',
    es: 'Dado de baja',
  },
  'consent.UNKNOWN': {
    pt: 'Consentimento desconhecido',
    en: 'Consent unknown',
    es: 'Consentimiento desconocido',
  },

  // ─── The Meta errors a rep can see on a bubble (appendix B) ───────────────
  'error.131047': {
    pt: 'Fora da janela de 24 horas — use um modelo.',
    en: 'Outside the 24-hour window — use a template.',
    es: 'Fuera de la ventana de 24 horas: usa una plantilla.',
  },
  'error.131026': {
    pt: 'Este número não está no WhatsApp.',
    en: 'This number is not on WhatsApp.',
    es: 'Este número no está en WhatsApp.',
  },
  'error.131049': {
    pt: 'A Meta limitou as mensagens de marketing para este contacto hoje.',
    en: 'Meta capped marketing messages to this contact today.',
    es: 'Meta limitó hoy los mensajes de marketing a este contacto.',
  },
  'error.131000': {
    pt: 'Erro temporário da Meta.',
    en: 'Temporary Meta error.',
    es: 'Error temporal de Meta.',
  },
  'error.130429': {
    pt: 'Limite de envio atingido — tente novamente.',
    en: 'Send limit reached — try again.',
    es: 'Se alcanzó el límite de envíos. Inténtalo de nuevo.',
  },
  'error.132000': {
    pt: 'O modelo não corresponde às variáveis enviadas.',
    en: 'The template does not match the variables sent.',
    es: 'La plantilla no coincide con las variables enviadas.',
  },
  'error.132001': {
    pt: 'O modelo não existe ou não está aprovado.',
    en: 'The template does not exist or is not approved.',
    es: 'La plantilla no existe o no está aprobada.',
  },
  'error.132012': {
    pt: 'Um valor de variável foi recusado pela Meta.',
    en: 'Meta rejected a variable value.',
    es: 'Meta rechazó el valor de una variable.',
  },
  'error.133010': {
    pt: 'O número não está registado na Meta.',
    en: 'The number is not registered with Meta.',
    es: 'El número no está registrado con Meta.',
  },
  'error.POLICY_WINDOW_CLOSED': {
    pt: 'A janela fechou antes do envio.',
    en: 'The window closed before the message was sent.',
    es: 'La ventana se cerró antes de que el mensaje saliera.',
  },
  'error.POLICY_OPTED_OUT': {
    pt: 'O contacto cancelou a subscrição antes do envio.',
    en: 'The contact unsubscribed before the message was sent.',
    es: 'El contacto canceló la suscripción antes de que el mensaje saliera.',
  },
  'error.POLICY_TEMPLATE_UNAVAILABLE': {
    pt: 'O modelo deixou de estar disponível.',
    en: 'The template became unavailable.',
    es: 'La plantilla dejó de estar disponible.',
  },
  'error.POLICY_ACCOUNT_ERROR': {
    pt: 'O número deixou de estar ligado.',
    en: 'The number is no longer connected.',
    es: 'El número ya no está conectado.',
  },
  'error.UNKNOWN_ACCEPTANCE': {
    pt: 'Resultado desconhecido — verifique antes de reenviar.',
    en: 'Unknown outcome — check before resending.',
    es: 'Resultado desconocido: verifica antes de reenviar.',
  },
  'error.MEDIA_TOO_LARGE': {
    pt: 'O ficheiro excede o limite da Meta.',
    en: 'The file exceeds Meta’s limit.',
    es: 'El archivo supera el límite de Meta.',
  },
  'error.MEDIA_UNAVAILABLE': {
    pt: 'O ficheiro já não está disponível na Meta.',
    en: 'The file is no longer available from Meta.',
    es: 'El archivo ya no está disponible en Meta.',
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
    es: 'No se pudo leer el archivo desde Twenty: {detail}',
  },
  'error.CANCELLED': {
    pt: 'Cancelada.',
    en: 'Cancelled.',
    es: 'Cancelado.',
  },
  'error.INTERNAL_TIMEOUT': {
    pt: 'Tempo esgotado.',
    en: 'Timed out.',
    es: 'Se agotó el tiempo de espera.',
  },
  'error.CONFIG_MISSING': {
    pt: 'Configuração em falta.',
    en: 'Missing configuration.',
    es: 'Falta configuración.',
  },
  'error.unknown': {
    pt: 'Erro não catalogado.',
    en: 'Uncatalogued error.',
    es: 'Error no catalogado.',
  },

  // ─── Campaign exclusions (specs/07) ───────────────────────────────────────
  'exclusion.OPTED_OUT': {
    pt: 'Cancelou a subscrição',
    en: 'Unsubscribed',
    es: 'Dado de baja',
  },
  'exclusion.NO_CONSENT': {
    pt: 'Sem consentimento',
    en: 'No consent',
    es: 'Sin consentimiento',
  },
  'exclusion.INVALID_PHONE': {
    pt: 'Número inválido',
    en: 'Invalid number',
    es: 'Número inválido',
  },
  'exclusion.DUPLICATE': {
    pt: 'Duplicado',
    en: 'Duplicate',
    es: 'Duplicado',
  },
  'exclusion.MISSING_VARIABLES': {
    pt: 'Variáveis em falta',
    en: 'Missing variables',
    es: 'Faltan variables',
  },
  'exclusion.BLOCKED': {
    pt: 'Conversa bloqueada',
    en: 'Blocked conversation',
    es: 'Conversación bloqueada',
  },

  // ─── Shared verbs ─────────────────────────────────────────────────────────
  'common.cancel': {
    pt: 'Cancelar',
    en: 'Cancel',
    es: 'Cancelar',
  },
  'common.save': {
    pt: 'Guardar',
    en: 'Save',
    es: 'Guardar',
  },
  'common.back': {
    pt: 'Voltar',
    en: 'Back',
    es: 'Atrás',
  },
  'common.continue': {
    pt: 'Continuar',
    en: 'Continue',
    es: 'Continuar',
  },
  'common.refresh': {
    pt: 'Actualizar',
    en: 'Refresh',
    es: 'Actualizar',
  },
  'common.retry': {
    pt: 'Tentar de novo',
    en: 'Try again',
    es: 'Reintentar',
  },
  'common.unavailable': {
    pt: 'Não foi possível ler os dados.',
    en: 'The data could not be read.',
    es: 'No se pudieron leer los datos.',
  },
  'common.copy': {
    pt: 'Copiar',
    en: 'Copy',
    es: 'Copiar',
  },
  'common.loading': {
    pt: 'A carregar…',
    en: 'Loading…',
    es: 'Cargando…',
  },
  'common.none': {
    pt: 'Nenhuma',
    en: 'None',
    es: 'Ninguno',
  },
  'common.yes': {
    pt: 'sim',
    en: 'yes',
    es: 'sí',
  },
  'common.no': {
    pt: 'não',
    en: 'no',
    es: 'no',
  },
  'common.dismiss': {
    pt: 'Fechar aviso',
    en: 'Dismiss',
    es: 'Descartar',
  },
  'common.clear': {
    pt: 'Limpar',
    en: 'Clear',
    es: 'Limpiar',
  },
  'common.more': {
    pt: 'Mais',
    en: 'More',
    es: 'Más',
  },
  'common.less': {
    pt: 'Menos',
    en: 'Less',
    es: 'Menos',
  },

  // ─── Chat ─────────────────────────────────────────────────────────────────
  'chat.windowOpen': {
    pt: 'Janela aberta',
    en: 'Window open',
    es: 'Ventana abierta',
  },
  'chat.windowClosed': {
    pt: 'Janela fechada',
    en: 'Window closed',
    es: 'Ventana cerrada',
  },
  'chat.closesIn': {
    pt: 'fecha em {time}',
    en: 'closes in {time}',
    es: 'se cierra en {time}',
  },
  'chat.loadOlder': {
    pt: 'Carregar mensagens anteriores',
    en: 'Load earlier messages',
    es: 'Cargar mensajes anteriores',
  },
  'chat.empty': {
    pt: 'Ainda não há mensagens nesta conversa.',
    en: 'No messages in this conversation yet.',
    es: 'Todavía no hay mensajes en esta conversación.',
  },
  'chat.noThread': {
    pt: 'Este contacto ainda não tem conversa de WhatsApp.',
    en: 'This contact has no WhatsApp conversation yet.',
    es: 'Este contacto todavía no tiene una conversación de WhatsApp.',
  },
  'chat.start': {
    pt: 'Iniciar conversa',
    en: 'Start a conversation',
    es: 'Iniciar una conversación',
  },
  'chat.placeholder': {
    pt: 'Escreva uma mensagem',
    en: 'Write a message',
    es: 'Escribe un mensaje',
  },
  'chat.send': {
    pt: 'Enviar',
    en: 'Send',
    es: 'Enviar',
  },
  'chat.chooseTemplate': {
    pt: 'Escolher modelo',
    en: 'Choose a template',
    es: 'Elige una plantilla',
  },
  'chat.templateHeader': {
    pt: 'Cabeçalho',
    en: 'Header',
    es: 'Encabezado',
  },
  // The three media header formats, named as the thing the rep has to find.
  'chat.templateHeader.IMAGE': {
    pt: 'Imagem',
    en: 'Image',
    es: 'Imagen',
  },
  'chat.templateHeader.VIDEO': {
    pt: 'Vídeo',
    en: 'Video',
    es: 'Video',
  },
  'chat.templateHeader.DOCUMENT': {
    pt: 'Documento',
    en: 'Document',
    es: 'Documento',
  },
  'chat.templateHeaderMedia': {
    pt: 'Ficheiro do cabeçalho, guardado no Twenty',
    en: 'Header file, stored in Twenty',
    es: 'Archivo del encabezado, guardado en Twenty',
  },
  'chat.fileUrlPlaceholder': {
    pt: 'https://…/files/attachment/…',
    en: 'https://…/files/attachment/…',
    es: 'https://…/files/attachment/…',
  },
  'chat.templateButton': {
    pt: 'Botão',
    en: 'Button',
    es: 'Botón',
  },
  'chat.templateButtonUrl': {
    pt: 'Ligação do botão',
    en: 'Button link',
    es: 'Enlace del botón',
  },
  'chat.templateCopyCode': {
    pt: 'Código a copiar',
    en: 'Copy code',
    es: 'Copiar código',
  },
  'chat.retry': {
    pt: 'Repetir',
    en: 'Retry',
    es: 'Reintentar',
  },
  'chat.details': {
    pt: 'Ver detalhes',
    en: 'Show details',
    es: 'Ver detalles',
  },
  'chat.voiceNote': {
    pt: 'Mensagem de voz',
    en: 'Voice message',
    es: 'Mensaje de voz',
  },
  'chat.download': {
    pt: 'Transferir ({size})',
    en: 'Download ({size})',
    es: 'Descargar ({size})',
  },
  'chat.unsupported': {
    pt: 'Mensagem não suportada',
    en: 'Unsupported message',
    es: 'Mensaje no compatible',
  },
  'chat.today': {
    pt: 'Hoje',
    en: 'Today',
    es: 'Hoy',
  },
  'chat.yesterday': {
    pt: 'Ontem',
    en: 'Yesterday',
    es: 'Ayer',
  },
  'chat.reconnect': {
    pt: 'Retomar actualizações',
    en: 'Resume updates',
    es: 'Reanudar actualizaciones',
  },
  'chat.suspended': {
    pt: 'Actualizações em pausa.',
    en: 'Updates paused.',
    es: 'Actualizaciones en pausa.',
  },
  'chat.offline': {
    pt: 'Sem ligação ao servidor.',
    en: 'No connection to the server.',
    es: 'Sin conexión con el servidor.',
  },
  'chat.sending': {
    pt: 'A enviar…',
    en: 'Sending…',
    es: 'Enviando…',
  },
  'chat.campaign': {
    pt: 'Campanha',
    en: 'Campaign',
    es: 'Campaña',
  },
  'chat.aiAgent': {
    pt: 'Agente de IA',
    en: 'AI agent',
    es: 'Agente de IA',
  },
  'chat.template': {
    pt: 'Modelo',
    en: 'Template',
    es: 'Plantilla',
  },
  'chat.needsReview': {
    pt: 'Por identificar',
    en: 'Unidentified',
    es: 'Sin identificar',
  },
  'chat.blocked': {
    pt: 'Bloqueada',
    en: 'Blocked',
    es: 'Bloqueada',
  },
  'chat.testAccount': {
    pt: 'Número de teste',
    en: 'Test number',
    es: 'Número de prueba',
  },
  'chat.qualityYellow': {
    pt: 'Qualidade do número: amarelo',
    en: 'Number quality: yellow',
    es: 'Calidad del número: amarilla',
  },
  'chat.qualityRed': {
    pt: 'Qualidade do número: vermelho',
    en: 'Number quality: red',
    es: 'Calidad del número: roja',
  },
  'chat.accountError': {
    pt: 'O número de WhatsApp não está ligado.',
    en: 'The WhatsApp number is not connected.',
    es: 'El número de WhatsApp no está conectado.',
  },
  'chat.block': {
    pt: 'Bloquear',
    en: 'Block',
    es: 'Bloquear',
  },
  'chat.unblock': {
    pt: 'Desbloquear',
    en: 'Unblock',
    es: 'Desbloquear',
  },
  'chat.blockConfirmTitle': {
    pt: 'Bloquear esta conversa?',
    en: 'Block this conversation?',
    es: '¿Bloquear esta conversación?',
  },
  'chat.blockConfirmSubtitle': {
    pt: 'Nenhuma mensagem será enviada nem recebida enquanto estiver bloqueada. Pode desbloquear a qualquer momento.',
    en: 'Nothing will be sent or received while it is blocked. You can unblock at any time.',
    es: 'No se enviará ni recibirá nada mientras esté bloqueada. Puedes desbloquearla cuando quieras.',
  },
  'chat.close': {
    pt: 'Fechar',
    en: 'Close',
    es: 'Cerrar',
  },
  'chat.reopen': {
    pt: 'Reabrir',
    en: 'Reopen',
    es: 'Reabrir',
  },
  'chat.noTemplates': {
    pt: 'Não há modelos publicados para este número.',
    en: 'No published templates for this number.',
    es: 'No hay plantillas publicadas para este número.',
  },
  'chat.missing': {
    pt: 'Em falta',
    en: 'Missing',
    es: 'Faltan',
  },
  'chat.noPermission': {
    pt: 'Sem permissão para enviar.',
    en: 'You may not send messages.',
    es: 'No tienes permiso para enviar mensajes.',
  },
  'chat.detailsHide': {
    pt: 'Ocultar detalhes',
    en: 'Hide details',
    es: 'Ocultar detalles',
  },
  'chat.file': {
    pt: 'ficheiro',
    en: 'file',
    es: 'archivo',
  },
  'chat.quoted': {
    pt: 'Em resposta a uma mensagem',
    en: 'In reply to a message',
    es: 'En respuesta a un mensaje',
  },
  'chat.detail.address': {
    pt: 'Morada',
    en: 'Address',
    es: 'Dirección',
  },
  'chat.detail.coordinates': {
    pt: 'Coordenadas',
    en: 'Coordinates',
    es: 'Coordenadas',
  },
  'chat.detail.contact': {
    pt: 'Contacto',
    en: 'Contact',
    es: 'Contacto',
  },
  'chat.detail.phone': {
    pt: 'Telefone',
    en: 'Phone',
    es: 'Teléfono',
  },
  'chat.detail.description': {
    pt: 'Descrição',
    en: 'Description',
    es: 'Descripción',
  },

  // ─── The conversation's own empty states (review §"empty state") ──────────
  'chat.emptyBody': {
    pt: 'Escreva a primeira mensagem, ou escolha um modelo aprovado.',
    en: 'Write the first message, or pick an approved template.',
    es: 'Escribe el primer mensaje o elige una plantilla aprobada.',
  },
  'chat.noThreadBody': {
    pt: 'Envie um modelo aprovado para começar. A resposta do contacto abre a janela de 24 horas e a partir daí pode escrever livremente.',
    en: 'Send an approved template to begin. The contact’s reply opens the 24-hour window, and from then on you can write freely.',
    es: 'Envía una plantilla aprobada para empezar. La respuesta del contacto abre la ventana de 24 horas, y a partir de ahí puedes escribir libremente.',
  },
  'chat.startWithTemplate': {
    pt: 'Começar com um modelo',
    en: 'Start with a template',
    es: 'Empezar con una plantilla',
  },
  'chat.windowClosedTitle': {
    pt: 'A janela de 24 horas fechou',
    en: 'The 24-hour window has closed',
    es: 'La ventana de 24 horas se cerró',
  },
  'chat.windowClosedBody': {
    pt: 'Fora da janela só um modelo aprovado chega ao contacto. A resposta dele reabre a janela.',
    en: 'Outside the window only an approved template reaches the contact. Their reply reopens it.',
    es: 'Fuera de la ventana solo una plantilla aprobada llega al contacto. Su respuesta la vuelve a abrir.',
  },
  'chat.consentTitle': {
    pt: 'Este contacto não pode ser contactado',
    en: 'This contact cannot be messaged',
    es: 'No se le puede escribir a este contacto',
  },
  'chat.reviewConsent': {
    pt: 'Rever consentimento',
    en: 'Review consent',
    es: 'Revisar consentimiento',
  },
  'chat.reviewConsentBody': {
    pt: 'O consentimento vive no registo da Pessoa, no campo de subscrição de WhatsApp.',
    en: 'Consent lives on the Person record, in the WhatsApp subscription field.',
    es: 'El consentimiento vive en la ficha de la Persona, en el campo de suscripción de WhatsApp.',
  },
  'chat.setupTitle': {
    pt: 'Falta ligar um número',
    en: 'No number is connected',
    es: 'No hay ningún número conectado',
  },
  'chat.setupBody': {
    pt: 'Um administrador liga o número em Definições → Aplicações → WhatsApp. Até lá não é possível enviar nem receber.',
    en: 'An admin connects the number in Settings → Applications → WhatsApp. Until then nothing can be sent or received.',
    es: 'Un administrador conecta el número en Ajustes → Aplicaciones → WhatsApp. Hasta entonces no se puede enviar ni recibir nada.',
  },
  'chat.blockedTitle': {
    pt: 'Não é possível enviar agora',
    en: 'Sending is not possible right now',
    es: 'Ahora mismo no se puede enviar',
  },
  'chat.blockedBody': {
    pt: 'O servidor recusou o envio para este contacto.',
    en: 'The server refused a send to this contact.',
    es: 'El servidor rechazó un envío a este contacto.',
  },
  'chat.noPhoneTitle': {
    pt: 'Sem número utilizável',
    en: 'No usable number',
    es: 'Sin número utilizable',
  },
  'chat.noPhoneBody': {
    pt: 'Este contacto não tem um telefone que possa ser convertido num número de WhatsApp. Corrija-o no registo da Pessoa.',
    en: 'This contact has no phone that converts to a WhatsApp number. Fix it on the Person record.',
    es: 'Este contacto no tiene un teléfono que se convierta en número de WhatsApp. Corrígelo en la ficha de la Persona.',
  },

  // ─── Who is handling a conversation (FR-THR-3) ────────────────────────────
  'chat.assignedToYou': {
    pt: 'Sua',
    en: 'Yours',
    es: 'Tuya',
  },
  'chat.assignedToOther': {
    pt: 'Com responsável',
    en: 'Assigned',
    es: 'Asignada',
  },
  'chat.unassigned': {
    pt: 'Sem responsável',
    en: 'Unassigned',
    es: 'Sin asignar',
  },
  'chat.assignToMe': {
    pt: 'Atribuir a mim',
    en: 'Assign to me',
    es: 'Asignármela',
  },
  'chat.unassign': {
    pt: 'Remover responsável',
    en: 'Unassign',
    es: 'Quitar asignación',
  },
  'chat.assignFailed': {
    pt: 'Não foi possível mudar o responsável.',
    en: 'The owner could not be changed.',
    es: 'No se pudo cambiar el responsable.',
  },

  // ─── Message actions (spec §"Message action model") ───────────────────────
  'chat.action.react': {
    pt: 'Reagir',
    en: 'React',
    es: 'Reaccionar',
  },
  'chat.action.reply': {
    pt: 'Responder',
    en: 'Reply',
    es: 'Responder',
  },
  'chat.action.copy': {
    pt: 'Copiar texto',
    en: 'Copy text',
    es: 'Copiar texto',
  },
  'chat.action.copied': {
    pt: 'Copiado',
    en: 'Copied',
    es: 'Copiado',
  },
  'chat.action.copyFailed': {
    pt: 'Não foi possível copiar.',
    en: 'The text could not be copied.',
    es: 'No se pudo copiar el texto.',
  },
  'chat.action.download': {
    pt: 'Transferir',
    en: 'Download',
    es: 'Descargar',
  },
  'chat.action.openImage': {
    pt: 'Abrir imagem',
    en: 'Open image',
    es: 'Abrir imagen',
  },
  'chat.action.openVideo': {
    pt: 'Abrir vídeo',
    en: 'Open video',
    es: 'Abrir video',
  },
  'chat.action.openMap': {
    pt: 'Abrir mapa',
    en: 'Open map',
    es: 'Abrir mapa',
  },
  'chat.action.openDocument': {
    pt: 'Abrir documento',
    en: 'Open document',
    es: 'Abrir documento',
  },
  'chat.action.moreEmoji': {
    pt: 'Mais emoji',
    en: 'More emoji',
    es: 'Más emojis',
  },
  'chat.action.removeReaction': {
    pt: 'Remover a sua reacção',
    en: 'Remove your reaction',
    es: 'Quitar tu reacción',
  },
  'chat.action.reactWith': {
    pt: 'Reagir com {emoji}',
    en: 'React with {emoji}',
    es: 'Reaccionar con {emoji}',
  },
  'chat.action.close': {
    pt: 'Fechar',
    en: 'Close',
    es: 'Cerrar',
  },
  'chat.action.forMessage': {
    pt: 'Acções para esta mensagem',
    en: 'Actions for this message',
    es: 'Acciones para este mensaje',
  },

  // ─── Reply and quote strip (spec §"Reply UX") ─────────────────────────────
  'chat.replyingTo': {
    pt: 'A responder a {sender}',
    en: 'Replying to {sender}',
    es: 'Respondiendo a {sender}',
  },
  'chat.you': {
    pt: 'Si',
    en: 'You',
    es: 'Tú',
  },
  'chat.cancelReply': {
    pt: 'Cancelar resposta',
    en: 'Cancel reply',
    es: 'Cancelar respuesta',
  },
  'chat.quoteUnavailable': {
    pt: 'Mensagem original indisponível',
    en: 'Original message unavailable',
    es: 'Mensaje original no disponible',
  },

  // ─── What each content type is called ─────────────────────────────────────
  'chat.type.TEXT': {
    pt: 'Mensagem',
    en: 'Message',
    es: 'Mensaje',
  },
  'chat.type.IMAGE': {
    pt: 'Imagem',
    en: 'Photo',
    es: 'Foto',
  },
  'chat.type.VIDEO': {
    pt: 'Vídeo',
    en: 'Video',
    es: 'Video',
  },
  'chat.type.AUDIO': {
    pt: 'Áudio',
    en: 'Audio',
    es: 'Audio',
  },
  'chat.type.DOCUMENT': {
    pt: 'Documento',
    en: 'Document',
    es: 'Documento',
  },
  'chat.type.STICKER': {
    pt: 'Autocolante',
    en: 'Sticker',
    es: 'Sticker',
  },
  'chat.type.LOCATION': {
    pt: 'Localização',
    en: 'Location',
    es: 'Ubicación',
  },
  'chat.type.CONTACTS': {
    pt: 'Contacto',
    en: 'Contact',
    es: 'Contacto',
  },
  'chat.type.TEMPLATE': {
    pt: 'Modelo',
    en: 'Template',
    es: 'Plantilla',
  },
  'chat.type.INTERACTIVE': {
    pt: 'Mensagem interactiva',
    en: 'Interactive message',
    es: 'Mensaje interactivo',
  },
  'chat.type.BUTTON_REPLY': {
    pt: 'Resposta rápida',
    en: 'Quick reply',
    es: 'Respuesta rápida',
  },
  'chat.type.LIST_REPLY': {
    pt: 'Opção da lista',
    en: 'List option',
    es: 'Opción de lista',
  },
  'chat.type.REACTION': {
    pt: 'Reacção',
    en: 'Reaction',
    es: 'Reacción',
  },
  'chat.type.SYSTEM': {
    pt: 'Evento do sistema',
    en: 'System event',
    es: 'Evento del sistema',
  },
  /**
   * Reached only through `chat.type.${type}`, like every row above it — but this
   * is the one a scanner would never see used, because `UNSUPPORTED` is the
   * branch that exists precisely for types nobody has written code for.
   */
  'chat.type.UNSUPPORTED': {
    pt: 'Mensagem não suportada',
    en: 'Unsupported message',
    es: 'Mensaje no compatible',
  },

  // ─── Rich renderers (spec §"Rich message renderer registry") ──────────────
  'chat.voiceMessage': {
    pt: 'Mensagem de voz',
    en: 'Voice message',
    es: 'Mensaje de voz',
  },
  'chat.audioFile': {
    pt: 'Ficheiro de áudio',
    en: 'Audio file',
    es: 'Archivo de audio',
  },
  'chat.duration': {
    pt: '{minutes}:{seconds}',
    en: '{minutes}:{seconds}',
    es: '{minutes}:{seconds}',
  },
  'chat.imageFailed': {
    pt: 'A imagem não pôde ser mostrada.',
    en: 'The image could not be shown.',
    es: 'No se pudo mostrar la imagen.',
  },
  'chat.playVideo': {
    pt: 'Reproduzir',
    en: 'Play',
    es: 'Reproducir',
  },
  'chat.mediaPending': {
    pt: 'A transferir…',
    en: 'Downloading…',
    es: 'Descargando…',
  },
  'chat.selectedQuickReply': {
    pt: 'Escolheu uma resposta rápida',
    en: 'Selected a quick reply',
    es: 'Eligió una respuesta rápida',
  },
  'chat.selectedFromList': {
    pt: 'Escolheu da lista',
    en: 'Selected from the list',
    es: 'Eligió de la lista',
  },
  'chat.flowResponse': {
    pt: 'Resposta a um formulário',
    en: 'Form response',
    es: 'Respuesta de formulario',
  },
  'chat.interactiveButtons': {
    pt: 'Botões de resposta rápida',
    en: 'Quick reply buttons',
    es: 'Botones de respuesta rápida',
  },
  'chat.interactiveList': {
    pt: 'Mensagem com lista',
    en: 'List message',
    es: 'Mensaje con lista',
  },
  'chat.listOptions': {
    pt: '{count} opções',
    en: '{count} options',
    es: '{count} opciones',
  },
  'chat.viewOptions': {
    pt: 'Ver opções',
    en: 'View options',
    es: 'Ver opciones',
  },
  'chat.hideOptions': {
    pt: 'Ocultar opções',
    en: 'Hide options',
    es: 'Ocultar opciones',
  },
  'chat.systemEvent': {
    pt: 'Evento do sistema',
    en: 'System event',
    es: 'Evento del sistema',
  },
  'chat.unsupportedBody': {
    pt: 'Esta mensagem chegou num formato que a aplicação ainda não mostra. O conteúdo original ficou guardado.',
    en: 'This message arrived in a format the app does not render yet. The original is stored.',
    es: 'Este mensaje llegó en un formato que la app todavía no sabe mostrar. El original queda guardado.',
  },

  // ─── Location and contact cards (spec §"Location and vCard design") ───────
  'chat.locationShared': {
    pt: 'Localização partilhada',
    en: 'Shared location',
    es: 'Ubicación compartida',
  },
  'chat.coordinates': {
    pt: '{latitude}, {longitude}',
    en: '{latitude}, {longitude}',
    es: '{latitude}, {longitude}',
  },
  'chat.contactShared': {
    pt: 'Contacto partilhado',
    en: 'Shared contact',
    es: 'Contacto compartido',
  },
  'chat.openPerson': {
    pt: 'Abrir contacto',
    en: 'Open person',
    es: 'Abrir persona',
  },
  'chat.createPerson': {
    pt: 'Criar contacto',
    en: 'Create person',
    es: 'Crear persona',
  },
  'chat.creatingPerson': {
    pt: 'A criar…',
    en: 'Creating…',
    es: 'Creando…',
  },
  'chat.contactReview': {
    pt: 'Estes dados são de terceiros. Reveja antes de criar um contacto.',
    en: 'This is third-party data. Review it before creating a person.',
    es: 'Estos son datos de un tercero. Revísalos antes de crear una persona.',
  },

  // ─── Message details panel ────────────────────────────────────────────────
  'chat.detail.sent': {
    pt: 'Enviada',
    en: 'Sent',
    es: 'Enviado',
  },
  'chat.detail.delivered': {
    pt: 'Entregue',
    en: 'Delivered',
    es: 'Entregado',
  },
  'chat.detail.read': {
    pt: 'Lida',
    en: 'Read',
    es: 'Leído',
  },
  'chat.detail.accepted': {
    pt: 'Aceite pela Meta',
    en: 'Accepted by Meta',
    es: 'Aceptado por Meta',
  },
  'chat.detail.played': {
    pt: 'Ouvida',
    en: 'Played',
    es: 'Reproducido',
  },
  'chat.detail.failed': {
    pt: 'Falhou',
    en: 'Failed',
    es: 'Falló',
  },
  'chat.detail.type': {
    pt: 'Tipo',
    en: 'Type',
    es: 'Tipo',
  },
  'chat.detail.template': {
    pt: 'Modelo',
    en: 'Template',
    es: 'Plantilla',
  },
  'chat.detail.language': {
    pt: 'Idioma',
    en: 'Language',
    es: 'Idioma',
  },
  'chat.detail.category': {
    pt: 'Categoria',
    en: 'Category',
    es: 'Categoría',
  },
  'chat.detail.file': {
    pt: 'Ficheiro',
    en: 'File',
    es: 'Archivo',
  },
  'chat.detail.size': {
    pt: 'Tamanho',
    en: 'Size',
    es: 'Tamaño',
  },
  'chat.detail.buttonId': {
    pt: 'Identificador do botão',
    en: 'Button id',
    es: 'Id del botón',
  },
  'chat.detail.rowId': {
    pt: 'Identificador da linha',
    en: 'Row id',
    es: 'Id de la fila',
  },
  'chat.detail.organization': {
    pt: 'Organização',
    en: 'Organisation',
    es: 'Organización',
  },
  'chat.detail.email': {
    pt: 'Email',
    en: 'Email',
    es: 'Correo',
  },
  'chat.detail.reactions': {
    pt: 'Reacções',
    en: 'Reactions',
    es: 'Reacciones',
  },
  'chat.detail.attempts': {
    pt: 'Tentativas',
    en: 'Attempts',
    es: 'Intentos',
  },

  // ─── Composer ＋ sheet (spec §"Composer redesign") ─────────────────────────
  'chat.attach': {
    pt: 'Anexar',
    en: 'Attach',
    es: 'Adjuntar',
  },
  'chat.collapsePanel': {
    pt: 'Recolher e ver a conversa',
    en: 'Collapse and see the conversation',
    es: 'Contraer y ver la conversación',
  },
  'chat.expandPanel': {
    pt: 'Expandir',
    en: 'Expand',
    es: 'Expandir',
  },
  'chat.attachTitle': {
    pt: 'Enviar…',
    en: 'Send…',
    es: 'Enviar…',
  },
  'chat.emoji': {
    pt: 'Emoji',
    en: 'Emoji',
    es: 'Emoji',
  },
  'chat.attachPhoto': {
    pt: 'Foto ou vídeo',
    en: 'Photo or video',
    es: 'Foto o video',
  },
  'chat.attachDocument': {
    pt: 'Documento',
    en: 'Document',
    es: 'Documento',
  },
  'chat.attachVoice': {
    pt: 'Mensagem de voz',
    en: 'Voice message',
    es: 'Mensaje de voz',
  },
  'chat.attachLocation': {
    pt: 'Localização',
    en: 'Location',
    es: 'Ubicación',
  },
  'chat.attachContact': {
    pt: 'Contacto',
    en: 'Contact',
    es: 'Contacto',
  },
  'chat.attachQuickReplies': {
    pt: 'Respostas rápidas',
    en: 'Quick replies',
    es: 'Respuestas rápidas',
  },
  'chat.attachList': {
    pt: 'Mensagem com lista',
    en: 'List message',
    es: 'Mensaje con lista',
  },
  'chat.attachTemplate': {
    pt: 'Modelo aprovado',
    en: 'Approved template',
    es: 'Plantilla aprobada',
  },
  'chat.unavailableHere': {
    pt: 'Indisponível nesta conversa',
    en: 'Not available in this conversation',
    es: 'No disponible en esta conversación',
  },
  /**
   * Two sources, not three: "from this device" was tried and retired — the
   * sandbox bridge hands a picked file's metadata over without its bytes
   * (D-53 field correction, specs/00), so every device pick failed.
   */
  'chat.sourceLabel': {
    pt: 'Origem do ficheiro',
    en: 'File source',
    es: 'Origen del archivo',
  },
  'chat.source.recent': {
    pt: 'Recentes da conversa',
    en: 'Recent in this chat',
    es: 'Recientes en este chat',
  },
  'chat.source.link': {
    pt: 'Já no Twenty',
    en: 'Already in Twenty',
    es: 'Ya está en Twenty',
  },
  // ─── The workspace-file picker inside "already in Twenty" ─────────────────
  'chat.fileSearchLabel': {
    pt: 'Procurar ficheiros no Twenty',
    en: 'Search files in Twenty',
    es: 'Buscar archivos en Twenty',
  },
  'chat.fileSearching': {
    pt: 'A procurar…',
    en: 'Searching…',
    es: 'Buscando…',
  },
  'chat.fileSearchNone': {
    pt: 'Nenhum ficheiro corresponde. Cole o endereço abaixo.',
    en: 'No files match. Paste the address below.',
    es: 'Ningún archivo coincide. Pega la dirección abajo.',
  },
  'chat.recentNone': {
    pt: 'Ainda não há ficheiros nesta conversa.',
    en: 'No files in this conversation yet.',
    es: 'Todavía no hay archivos en esta conversación.',
  },
  'chat.recentHint': {
    pt: 'Reutilize um ficheiro já enviado ou recebido nesta conversa.',
    en: 'Reuse a file already sent or received in this conversation.',
    es: 'Reutiliza un archivo ya enviado o recibido en esta conversación.',
  },

  // ─── Sending media from Twenty's own files ────────────────────────────────
  'chat.fileUrlLabel': {
    pt: 'Endereço do ficheiro no Twenty',
    en: 'Twenty file URL',
    es: 'URL del archivo en Twenty',
  },
  'chat.fileUrlHint': {
    pt: 'Abra o ficheiro a partir do registo no Twenty e copie o endereço da barra do navegador. Tem de conter /files/.',
    en: 'Open the file from its record in Twenty and copy the address from the browser bar. It has to contain /files/.',
    es: 'Abre el archivo desde su ficha en Twenty y copia la dirección de la barra del navegador. Tiene que contener /files/.',
  },
  'chat.fileNameLabel': {
    pt: 'Nome do ficheiro',
    en: 'File name',
    es: 'Nombre del archivo',
  },
  'chat.captionLabel': {
    pt: 'Legenda (opcional)',
    en: 'Caption (optional)',
    es: 'Descripción (opcional)',
  },
  'chat.mediaKindLabel': {
    pt: 'Tipo de anexo',
    en: 'Attachment type',
    es: 'Tipo de adjunto',
  },
  'chat.sendAttachment': {
    pt: 'Enviar anexo',
    en: 'Send attachment',
    es: 'Enviar adjunto',
  },
  'chat.fileUrlRequired': {
    pt: 'Indique o endereço do ficheiro.',
    en: 'Enter the file’s address.',
    es: 'Escribe la dirección del archivo.',
  },
  'chat.fileUrlInvalid': {
    pt: 'Este endereço não é válido.',
    en: 'That address is not valid.',
    es: 'Esa dirección no es válida.',
  },

  // ─── Voice recording ──────────────────────────────────────────────────────
  'chat.recordStart': {
    pt: 'Gravar mensagem de voz',
    en: 'Record a voice message',
    es: 'Grabar un mensaje de voz',
  },
  'chat.recordStop': {
    pt: 'Parar gravação',
    en: 'Stop recording',
    es: 'Detener la grabación',
  },
  'chat.recording': {
    pt: 'A gravar… {duration}',
    en: 'Recording… {duration}',
    es: 'Grabando… {duration}',
  },
  'chat.recordReview': {
    pt: 'Ouça antes de enviar.',
    en: 'Listen before sending.',
    es: 'Escúchalo antes de enviarlo.',
  },
  'chat.recordDiscard': {
    pt: 'Descartar',
    en: 'Discard',
    es: 'Descartar',
  },
  'chat.recordUnavailable': {
    pt: 'A gravação de áudio não está disponível neste navegador.',
    en: 'Audio recording is not available in this browser.',
    es: 'Este navegador no permite grabar audio.',
  },
  'chat.recordDenied': {
    pt: 'Sem acesso ao microfone. Autorize-o no navegador e tente de novo.',
    en: 'No microphone access. Allow it in the browser and try again.',
    es: 'Sin acceso al micrófono. Permítelo en el navegador e inténtalo de nuevo.',
  },
  'chat.recordUploading': {
    pt: 'A carregar a gravação…',
    en: 'Uploading the recording…',
    es: 'Subiendo la grabación…',
  },
  'chat.recordUploadFailed': {
    pt: 'Não foi possível carregar a gravação.',
    en: 'The recording could not be uploaded.',
    es: 'No se pudo subir la grabación.',
  },

  // ─── Location composer ────────────────────────────────────────────────────
  'chat.locationName': {
    pt: 'Nome do local (opcional)',
    en: 'Place name (optional)',
    es: 'Nombre del lugar (opcional)',
  },
  'chat.locationAddress': {
    pt: 'Morada (opcional)',
    en: 'Address (optional)',
    es: 'Dirección (opcional)',
  },
  'chat.latitude': {
    pt: 'Latitude',
    en: 'Latitude',
    es: 'Latitud',
  },
  'chat.longitude': {
    pt: 'Longitude',
    en: 'Longitude',
    es: 'Longitud',
  },
  'chat.sendLocation': {
    pt: 'Enviar localização',
    en: 'Send location',
    es: 'Enviar ubicación',
  },
  'chat.coordinatesRequired': {
    pt: 'Indique uma latitude entre -90 e 90 e uma longitude entre -180 e 180.',
    en: 'Enter a latitude between -90 and 90 and a longitude between -180 and 180.',
    es: 'Escribe una latitud entre -90 y 90 y una longitud entre -180 y 180.',
  },

  // ─── Contact composer ─────────────────────────────────────────────────────
  'chat.contactName': {
    pt: 'Nome',
    en: 'Name',
    es: 'Nombre',
  },
  'chat.contactPhone': {
    pt: 'Telefone',
    en: 'Phone',
    es: 'Teléfono',
  },
  'chat.contactOrganization': {
    pt: 'Organização (opcional)',
    en: 'Organisation (optional)',
    es: 'Organización (opcional)',
  },
  'chat.sendContact': {
    pt: 'Enviar contacto',
    en: 'Send contact',
    es: 'Enviar contacto',
  },
  'chat.contactNameRequired': {
    pt: 'Indique um nome.',
    en: 'Enter a name.',
    es: 'Escribe un nombre.',
  },
  'chat.useThisPerson': {
    pt: 'Usar este contacto',
    en: 'Use this person',
    es: 'Usar esta persona',
  },

  // ─── Interactive builders (spec §"Interactive-message authoring") ─────────
  'builder.header': {
    pt: 'Cabeçalho (opcional)',
    en: 'Header (optional)',
    es: 'Encabezado (opcional)',
  },
  'builder.body': {
    pt: 'Texto',
    en: 'Body',
    es: 'Cuerpo',
  },
  'builder.footer': {
    pt: 'Rodapé (opcional)',
    en: 'Footer (optional)',
    es: 'Pie (opcional)',
  },
  'builder.buttons': {
    pt: 'Botões',
    en: 'Buttons',
    es: 'Botones',
  },
  'builder.buttonTitle': {
    pt: 'Título do botão {index}',
    en: 'Button {index} title',
    es: 'Título del botón {index}',
  },
  'builder.addButton': {
    pt: 'Adicionar botão',
    en: 'Add a button',
    es: 'Agregar un botón',
  },
  'builder.removeButton': {
    pt: 'Remover botão {index}',
    en: 'Remove button {index}',
    es: 'Quitar el botón {index}',
  },
  'builder.buttonLabel': {
    pt: 'Texto do botão da lista',
    en: 'List button label',
    es: 'Etiqueta del botón de lista',
  },
  'builder.section': {
    pt: 'Secção {index}',
    en: 'Section {index}',
    es: 'Sección {index}',
  },
  'builder.sectionTitle': {
    pt: 'Título da secção {index}',
    en: 'Section {index} title',
    es: 'Título de la sección {index}',
  },
  'builder.addSection': {
    pt: 'Adicionar secção',
    en: 'Add a section',
    es: 'Agregar una sección',
  },
  'builder.removeSection': {
    pt: 'Remover secção {index}',
    en: 'Remove section {index}',
    es: 'Quitar la sección {index}',
  },
  'builder.row': {
    pt: 'Linha {index}',
    en: 'Row {index}',
    es: 'Fila {index}',
  },
  'builder.rowTitle': {
    pt: 'Título da linha {index}',
    en: 'Row {index} title',
    es: 'Título de la fila {index}',
  },
  'builder.rowDescription': {
    pt: 'Descrição da linha {index} (opcional)',
    en: 'Row {index} description (optional)',
    es: 'Descripción de la fila {index} (opcional)',
  },
  'builder.addRow': {
    pt: 'Adicionar linha',
    en: 'Add a row',
    es: 'Agregar una fila',
  },
  'builder.removeRow': {
    pt: 'Remover linha {index}',
    en: 'Remove row {index}',
    es: 'Quitar la fila {index}',
  },
  'builder.moveUp': {
    pt: 'Mover para cima',
    en: 'Move up',
    es: 'Subir',
  },
  'builder.moveDown': {
    pt: 'Mover para baixo',
    en: 'Move down',
    es: 'Bajar',
  },
  'builder.rowsUsed': {
    pt: '{used} / {limit} linhas',
    en: '{used} / {limit} rows',
    es: '{used} / {limit} filas',
  },
  'builder.preview': {
    pt: 'Como o contacto vê',
    en: 'What the contact sees',
    es: 'Lo que ve el contacto',
  },
  'builder.sendButtons': {
    pt: 'Enviar respostas rápidas',
    en: 'Send quick replies',
    es: 'Enviar respuestas rápidas',
  },
  'builder.sendList': {
    pt: 'Enviar lista',
    en: 'Send list',
    es: 'Enviar lista',
  },
  'builder.quickRepliesTitle': {
    pt: 'Respostas rápidas',
    en: 'Quick replies',
    es: 'Respuestas rápidas',
  },
  'builder.listTitle': {
    pt: 'Mensagem com lista',
    en: 'List message',
    es: 'Mensaje con lista',
  },
  'builder.idsAreAutomatic': {
    pt: 'Os identificadores são gerados automaticamente e não mudam quando edita o texto.',
    en: 'Ids are generated automatically and do not change when you edit the text.',
    es: 'Los identificadores se generan solos y no cambian cuando editas el texto.',
  },

  /**
   * Field-addressed rejections, keyed by the code the validator returns. One
   * sentence per *kind* of mistake, because "invalid" under a box is the API
   * error message again in a nicer font.
   */
  'builder.error.REQUIRED': {
    pt: 'Obrigatório.',
    en: 'Required.',
    es: 'Obligatorio.',
  },
  'builder.error.TOO_LONG': {
    pt: 'Demasiado longo — máximo {limit} caracteres.',
    en: 'Too long — {limit} characters at most.',
    es: 'Demasiado largo: {limit} caracteres como máximo.',
  },
  'builder.error.TOO_FEW': {
    pt: 'Faltam entradas (mínimo {limit}).',
    en: 'Too few (at least {limit}).',
    es: 'Muy pocos (al menos {limit}).',
  },
  'builder.error.TOO_MANY': {
    pt: 'Demasiadas entradas (máximo {limit}).',
    en: 'Too many (at most {limit}).',
    es: 'Demasiados (máximo {limit}).',
  },
  'builder.error.DUPLICATE_ID': {
    pt: 'Este identificador já é usado por outra entrada.',
    en: 'Another entry already uses this id.',
    es: 'Otra entrada ya usa este identificador.',
  },
  'builder.error.UNSUPPORTED': {
    pt: 'Este formato não é suportado.',
    en: 'That format is not supported.',
    es: 'Ese formato no es compatible.',
  },
  /**
   * The specific refusal, not the generic one. "That format is not supported"
   * left a rep re-typing a perfectly valid address that simply pointed
   * somewhere the workspace cannot read from (D-58).
   */
  'builder.error.NOT_A_FILE_URL': {
    pt: 'Só é possível enviar ficheiros guardados no Twenty — o endereço tem de conter /files/.',
    en: 'Only files stored in Twenty can be sent — the address has to contain /files/.',
    es: 'Solo se pueden enviar archivos guardados en Twenty: la dirección tiene que contener /files/.',
  },
  'builder.invalid': {
    pt: 'Corrija os campos assinalados antes de enviar.',
    en: 'Fix the highlighted fields before sending.',
    es: 'Corrige los campos marcados antes de enviar.',
  },

  // ─── Inbox ────────────────────────────────────────────────────────────────
  'inbox.hideList': {
    pt: 'Ocultar lista',
    en: 'Hide list',
    es: 'Ocultar lista',
  },
  'inbox.showList': {
    pt: 'Mostrar lista',
    en: 'Show list',
    es: 'Mostrar lista',
  },
  'inbox.mine': {
    pt: 'Minhas',
    en: 'Mine',
    es: 'Mías',
  },
  'inbox.unassigned': {
    pt: 'Sem responsável',
    en: 'Unassigned',
    es: 'Sin asignar',
  },
  'inbox.all': {
    pt: 'Todas',
    en: 'All',
    es: 'Todas',
  },
  'inbox.unread': {
    pt: 'Por ler',
    en: 'Unread',
    es: 'Sin leer',
  },
  'inbox.campaign_replies': {
    pt: 'Respostas a campanhas',
    en: 'Campaign replies',
    es: 'Respuestas de campaña',
  },
  'inbox.window_expiring': {
    pt: 'A fechar',
    en: 'Closing soon',
    es: 'Por cerrarse',
  },
  'inbox.closed': {
    pt: 'Fechadas',
    en: 'Closed',
    es: 'Cerradas',
  },
  'inbox.pick': {
    pt: 'Escolha uma conversa',
    en: 'Pick a conversation',
    es: 'Elige una conversación',
  },
  'inbox.pickBody': {
    pt: 'A conversa escolhida abre aqui, com o histórico e a caixa de escrita.',
    en: 'The conversation you pick opens here, with its history and the composer.',
    es: 'La conversación que elijas se abre aquí, con su historial y la caja para escribir.',
  },
  'inbox.conversations': {
    pt: 'Conversas',
    en: 'Conversations',
    es: 'Conversaciones',
  },
  'inbox.empty': {
    pt: 'Nenhuma conversa neste filtro.',
    en: 'No conversations in this filter.',
    es: 'No hay conversaciones en este filtro.',
  },

  'inbox.search': {
    pt: 'Procurar conversas',
    en: 'Search conversations',
    es: 'Buscar conversaciones',
  },
  'inbox.searchScope': {
    pt: 'A procurar nas {count} conversas já carregadas.',
    en: 'Searching the {count} conversations already loaded.',
    es: 'Buscando entre las {count} conversaciones ya cargadas.',
  },
  'inbox.noMatches': {
    pt: 'Nada corresponde a “{query}”.',
    en: 'Nothing matches “{query}”.',
    es: 'Nada coincide con «{query}».',
  },
  'inbox.clearSearch': {
    pt: 'Limpar a procura',
    en: 'Clear the search',
    es: 'Limpiar la búsqueda',
  },
  'inbox.moreFilters': {
    pt: 'Mais filtros',
    en: 'More filters',
    es: 'Más filtros',
  },
  'inbox.fewerFilters': {
    pt: 'Menos filtros',
    en: 'Fewer filters',
    es: 'Menos filtros',
  },
  'inbox.filterCount': {
    pt: '{label}, {count} conversas',
    en: '{label}, {count} conversations',
    es: '{label}, {count} conversaciones',
  },

  'inbox.empty.mine': {
    pt: 'Nada atribuído a si.',
    en: 'Nothing assigned to you.',
    es: 'No tienes nada asignado.',
  },
  'inbox.empty.mineBody': {
    pt: 'As conversas de que se encarregar aparecem aqui. Comece pelas que ainda não têm responsável.',
    en: 'Conversations you take on appear here. Start with the ones nobody owns yet.',
    es: 'Las conversaciones que tomes aparecen aquí. Empieza por las que todavía no tienen dueño.',
  },
  'inbox.empty.unassigned': {
    pt: 'Todas as conversas têm responsável.',
    en: 'Every conversation has an owner.',
    es: 'Todas las conversaciones tienen dueño.',
  },
  'inbox.empty.unassignedBody': {
    pt: 'Nada está à espera de alguém a quem chamar.',
    en: 'Nothing is waiting for someone to claim it.',
    es: 'No hay nada esperando a que alguien lo tome.',
  },
  'inbox.empty.all': {
    pt: 'Ainda não há conversas.',
    en: 'No conversations yet.',
    es: 'Todavía no hay conversaciones.',
  },
  'inbox.empty.allBody': {
    pt: 'Uma conversa começa quando um cliente escreve para o seu número, ou quando envia um modelo a partir de um contacto.',
    en: 'A conversation starts when a customer writes to your number, or when you send a template from a contact.',
    es: 'Una conversación empieza cuando un cliente le escribe a tu número, o cuando le mandas una plantilla a un contacto.',
  },
  'inbox.empty.unread': {
    pt: 'Tudo lido.',
    en: 'All caught up.',
    es: 'Todo al día.',
  },
  'inbox.empty.unreadBody': {
    pt: 'Nenhuma conversa tem mensagens por ler. As novas mensagens aparecem aqui.',
    en: 'No conversation has unread messages. New messages show up here.',
    es: 'Ninguna conversación tiene mensajes sin leer. Los nuevos aparecen aquí.',
  },
  /**
   * The list can empty while a conversation stays open beside it — closing or
   * assigning the open thread is what removes it from the current filter.
   */
  'inbox.openNotInFilter': {
    pt: 'A conversa aberta já não pertence a este filtro.',
    en: 'The open conversation is no longer in this filter.',
    es: 'La conversación abierta ya no está en este filtro.',
  },
  'inbox.empty.campaign_replies': {
    pt: 'Ainda ninguém respondeu a uma campanha.',
    en: 'Nobody has replied to a campaign yet.',
    es: 'Nadie ha respondido a una campaña todavía.',
  },
  'inbox.empty.campaign_repliesBody': {
    pt: 'As respostas a mensagens de campanha juntam-se aqui, separadas do resto da caixa.',
    en: 'Replies to campaign messages collect here, kept apart from the rest of the inbox.',
    es: 'Las respuestas a mensajes de campaña se juntan aquí, aparte del resto del inbox.',
  },
  'inbox.empty.window_expiring': {
    pt: 'Nenhuma janela fecha nas próximas duas horas.',
    en: 'No window closes in the next two hours.',
    es: 'Ninguna ventana se cierra en las próximas dos horas.',
  },
  'inbox.empty.window_expiringBody': {
    pt: 'Este filtro mostra as conversas que perdem a janela de 24 horas em breve — as que valem uma resposta antes de exigirem um modelo.',
    en: 'This filter shows conversations about to lose their 24-hour window — the ones worth answering before they need a template.',
    es: 'Este filtro muestra las conversaciones a punto de perder su ventana de 24 horas: las que conviene responder antes de que necesiten una plantilla.',
  },
  'inbox.empty.closed': {
    pt: 'Nenhuma conversa fechada.',
    en: 'No closed conversations.',
    es: 'No hay conversaciones cerradas.',
  },
  'inbox.empty.closedBody': {
    pt: 'Fechar uma conversa é só uma etiqueta: qualquer mensagem nova volta a abri-la.',
    en: 'Closing a conversation is only a label: any new message reopens it.',
    es: 'Cerrar una conversación es solo una etiqueta: cualquier mensaje nuevo la reabre.',
  },
  'inbox.seeAll': {
    pt: 'Ver todas',
    en: 'See all',
    es: 'Ver todas',
  },
  'inbox.seeUnassigned': {
    pt: 'Ver sem responsável',
    en: 'See unassigned',
    es: 'Ver sin asignar',
  },
  'inbox.keyboardHint': {
    pt: 'Teclado: J e K mudam de conversa, A atribui-a a si.',
    en: 'Keyboard: J and K move between conversations, A assigns one to you.',
    es: 'Teclado: J y K se mueven entre conversaciones, A te asigna una.',
  },

  // ─── Live toasts (D-10 layer 2) ───────────────────────────────────────────
  'toast.newMessage': {
    pt: 'Nova mensagem de {name}',
    en: 'New message from {name}',
    es: 'Mensaje nuevo de {name}',
  },
  'toast.newMessages': {
    pt: '{count} conversas com mensagens novas',
    en: '{count} conversations with new messages',
    es: '{count} conversaciones con mensajes nuevos',
  },

  // ─── Campaigns ────────────────────────────────────────────────────────────
  'campaign.title': {
    pt: 'Campanhas',
    en: 'Campaigns',
    es: 'Campañas',
  },
  'campaign.new': {
    pt: 'Nova campanha',
    en: 'New campaign',
    es: 'Nueva campaña',
  },
  /** "Continue" rather than "Edit": the builder reopens where it was left. */
  'campaign.edit': {
    pt: 'Continuar a editar',
    en: 'Continue editing',
    es: 'Seguir editando',
  },
  'campaign.none': {
    pt: 'Ainda não há campanhas.',
    en: 'No campaigns yet.',
    es: 'Todavía no hay campañas.',
  },
  'campaign.noneBody': {
    pt: 'Uma campanha envia um modelo aprovado a uma audiência escolhida, e mostra entregas, respostas e custo à medida que decorre.',
    en: 'A campaign sends an approved template to a chosen audience, and shows deliveries, replies and cost as it runs.',
    es: 'Una campaña manda una plantilla aprobada a una audiencia elegida, y muestra entregas, respuestas y costo conforme avanza.',
  },

  'campaign.status.DRAFT': {
    pt: 'Rascunho',
    en: 'Draft',
    es: 'Borrador',
  },
  'campaign.status.SNAPSHOTTING': {
    pt: 'A construir audiência',
    en: 'Building audience',
    es: 'Armando audiencia',
  },
  'campaign.status.READY': {
    pt: 'Pronta',
    en: 'Ready',
    es: 'Lista',
  },
  'campaign.status.SCHEDULED': {
    pt: 'Agendada',
    en: 'Scheduled',
    es: 'Programada',
  },
  'campaign.status.RUNNING': {
    pt: 'A decorrer',
    en: 'Running',
    es: 'En curso',
  },
  'campaign.status.PAUSED': {
    pt: 'Em pausa',
    en: 'Paused',
    es: 'En pausa',
  },
  'campaign.status.TIER_WAITING': {
    pt: 'À espera do escalão',
    en: 'Waiting on the tier',
    es: 'Esperando el tier',
  },
  'campaign.status.COMPLETED': {
    pt: 'Concluída',
    en: 'Completed',
    es: 'Completada',
  },
  'campaign.status.CANCELLED': {
    pt: 'Cancelada',
    en: 'Cancelled',
    es: 'Cancelada',
  },
  'campaign.status.FAILED': {
    pt: 'Falhou',
    en: 'Failed',
    es: 'Fallida',
  },

  'campaign.search': {
    pt: 'Procurar campanhas',
    en: 'Search campaigns',
    es: 'Buscar campañas',
  },
  'campaign.noMatches': {
    pt: 'Nenhuma campanha corresponde a este filtro.',
    en: 'No campaign matches this filter.',
    es: 'Ninguna campaña coincide con este filtro.',
  },
  'campaign.filter.all': {
    pt: 'Todas',
    en: 'All',
    es: 'Todas',
  },
  'campaign.filter.drafts': {
    pt: 'Rascunhos',
    en: 'Drafts',
    es: 'Borradores',
  },
  'campaign.filter.scheduled': {
    pt: 'Agendadas',
    en: 'Scheduled',
    es: 'Programadas',
  },
  'campaign.filter.running': {
    pt: 'A decorrer',
    en: 'Running',
    es: 'En curso',
  },
  'campaign.filter.completed': {
    pt: 'Concluídas',
    en: 'Completed',
    es: 'Completadas',
  },
  'campaign.filter.attention': {
    pt: 'A precisar de atenção',
    en: 'Needs attention',
    es: 'Requieren atención',
  },
  'campaign.filter.archived': {
    pt: 'Arquivadas',
    en: 'Archived',
    es: 'Archivadas',
  },
  'campaign.open': {
    pt: 'Abrir campanha',
    en: 'Open campaign',
    es: 'Abrir campaña',
  },
  // The list row's quiet second line: who it targets, from which number.
  'campaign.audienceView': {
    pt: 'Vista guardada',
    en: 'Saved view',
    es: 'Vista guardada',
  },
  'campaign.audienceManual': {
    pt: '{count} contactos escolhidos',
    en: '{count} chosen contacts',
    es: '{count} contactos elegidos',
  },
  /** A zero-recipient draft the builder saved on the operator's way out. */
  'campaign.autosavedDraft': {
    pt: 'Rascunho guardado automaticamente',
    en: 'Autosaved draft',
    es: 'Borrador guardado solo',
  },
  'campaign.progress': {
    pt: '{done} de {total} enviadas',
    en: '{done} of {total} sent',
    es: '{done} de {total} enviados',
  },
  /**
   * Shown while every recipient is already attempted but the campaign record
   * still reads RUNNING — the asynchronous reconciliation that follows a run.
   */
  'campaign.finishing': {
    pt: 'A concluir — todas as mensagens foram enviadas',
    en: 'Finishing — every message has been sent',
    es: 'Terminando: ya se enviaron todos los mensajes',
  },
  'campaign.updated': {
    pt: 'Actualizado {when}',
    en: 'Updated {when}',
    es: 'Actualizada {when}',
  },
  'campaign.funnel': {
    pt: 'Funil de entrega',
    en: 'Delivery funnel',
    es: 'Embudo de entrega',
  },
  'campaign.funnelNote': {
    pt: 'Cada barra é uma percentagem dos destinatários da campanha.',
    en: 'Each bar is a share of the campaign’s recipients.',
    es: 'Cada barra es una parte de los destinatarios de la campaña.',
  },
  'campaign.running': {
    pt: 'Uma campanha está a decorrer — os números actualizam sozinhos.',
    en: 'A campaign is running — the figures update by themselves.',
    es: 'Hay una campaña en curso: las cifras se actualizan solas.',
  },
  'campaign.col.name': {
    pt: 'Nome',
    en: 'Name',
    es: 'Nombre',
  },
  'campaign.col.status': {
    pt: 'Estado',
    en: 'Status',
    es: 'Estado',
  },
  'campaign.col.created': {
    pt: 'Criada',
    en: 'Created',
    es: 'Creada',
  },
  'campaign.col.archived': {
    pt: 'Arquivada',
    en: 'Archived',
    es: 'Archivada',
  },
  'campaign.col.phone': {
    pt: 'Telefone',
    en: 'Phone',
    es: 'Teléfono',
  },
  'campaign.col.reason': {
    pt: 'Motivo',
    en: 'Reason',
    es: 'Motivo',
  },

  'campaign.step.basics': {
    pt: 'Básico',
    en: 'Basics',
    es: 'Datos básicos',
  },
  'campaign.step.template': {
    pt: 'Modelo',
    en: 'Template',
    es: 'Plantilla',
  },
  'campaign.step.audience': {
    pt: 'Audiência',
    en: 'Audience',
    es: 'Audiencia',
  },
  'campaign.step.variables': {
    pt: 'Variáveis',
    en: 'Variables',
    es: 'Variables',
  },
  'campaign.step.review': {
    pt: 'Rever',
    en: 'Review',
    es: 'Revisión',
  },
  'campaign.stepOf': {
    pt: 'Passo {step} de {total}',
    en: 'Step {step} of {total}',
    es: 'Paso {step} de {total}',
  },

  'campaign.previewTitle': {
    pt: 'Como fica a mensagem',
    en: 'How the message reads',
    es: 'Cómo se lee el mensaje',
  },
  /**
   * No braces in this one, deliberately. `{{marcador}}` and `{{placeholder}}`
   * are not the same token, and the parallel-placeholder test reads every
   * `{…}` in a string as an interpolation slot — so a sentence *about*
   * placeholders written with placeholders fails it, correctly.
   */
  'campaign.previewPlaceholders': {
    pt: 'As variáveis por preencher ficam à vista, entre chavetas duplas.',
    en: 'Unfilled variables stay visible, in double braces.',
    es: 'Las variables sin llenar quedan a la vista, entre llaves dobles.',
  },
  'campaign.previewSample': {
    pt: 'Com os valores de {name}, um contacto real desta audiência.',
    en: 'With the values of {name}, a real contact from this audience.',
    es: 'Con los valores de {name}, un contacto real de esta audiencia.',
  },
  'campaign.previewUnavailable': {
    pt: 'Ainda não foi possível ler um contacto de exemplo desta audiência.',
    en: 'No sample contact could be read from this audience yet.',
    es: 'Todavía no se pudo leer un contacto de muestra de esta audiencia.',
  },
  'campaign.reviewMissing': {
    pt: '{count} de {total} contactos da amostra ficam sem variáveis e seriam excluídos: {keys}.',
    en: '{count} of {total} sampled contacts are missing variables and would be excluded: {keys}.',
    es: 'A {count} de {total} contactos de la muestra les faltan variables y quedarían excluidos: {keys}.',
  },
  'campaign.reviewNoMissing': {
    pt: 'Todos os contactos da amostra têm as variáveis preenchidas.',
    en: 'Every sampled contact has its variables filled.',
    es: 'Todos los contactos de la muestra tienen sus variables llenas.',
  },
  'campaign.reviewAudienceView': {
    pt: 'Vista “{name}”',
    en: 'View “{name}”',
    es: 'Vista «{name}»',
  },
  'campaign.reviewAudienceManual': {
    pt: '{count} contactos escolhidos à mão',
    en: '{count} hand-picked contacts',
    es: '{count} contactos elegidos a mano',
  },
  'campaign.reviewScheduleNow': {
    pt: 'Assim que for lançada',
    en: 'As soon as it is launched',
    es: 'En cuanto se lance',
  },
  'campaign.reviewCountUnknown': {
    pt: 'O número exacto de destinatários, o custo e as exclusões saem da construção da audiência — aparecem no ecrã seguinte, antes de haver botão de lançamento.',
    en: 'The exact recipient count, the cost and the exclusions come out of the audience build — they appear on the next screen, before there is any launch button.',
    es: 'El número exacto de destinatarios, el costo y las exclusiones salen del armado de la audiencia: aparecen en la pantalla siguiente, antes de que haya botón de lanzar.',
  },
  'campaign.reviewWarnings': {
    pt: 'Avisos',
    en: 'Warnings',
    es: 'Advertencias',
  },
  'campaign.warnNotConnected': {
    pt: 'O número de envio não está ligado. A campanha não arranca assim.',
    en: 'The sending number is not connected. The campaign will not start like this.',
    es: 'El número emisor no está conectado. Así, la campaña no va a arrancar.',
  },
  'campaign.warnQualityRed': {
    pt: 'A qualidade do número está em vermelho — o lançamento vai exigir uma confirmação explícita.',
    en: 'The number’s quality is red — launching will need an explicit acknowledgement.',
    es: 'La calidad del número está en rojo: lanzar va a requerir una confirmación explícita.',
  },
  'campaign.warnQualityYellow': {
    pt: 'A qualidade do número está em amarelo. Vale rever o modelo antes de enviar a muita gente.',
    en: 'The number’s quality is yellow. Worth reviewing the template before sending to many people.',
    es: 'La calidad del número está en amarillo. Conviene revisar la plantilla antes de enviarla a mucha gente.',
  },
  'campaign.warnTestAccount': {
    pt: 'Este é um número de teste: a Meta só entrega a destinatários registados.',
    en: 'This is a test number: Meta only delivers to registered recipients.',
    es: 'Este es un número de prueba: Meta solo entrega a destinatarios registrados.',
  },

  'campaign.name': {
    pt: 'Nome',
    en: 'Name',
    es: 'Nombre',
  },
  'campaign.account': {
    pt: 'Número de envio',
    en: 'Sending number',
    es: 'Número emisor',
  },
  'campaign.schedule': {
    pt: 'Agendamento',
    en: 'Schedule',
    es: 'Programación',
  },
  'campaign.scheduleHint': {
    pt: 'Vazio envia assim que for lançada. A hora é a do seu navegador e é guardada em UTC.',
    en: 'Empty sends as soon as it is launched. The time is your browser’s and is stored in UTC.',
    es: 'Vacío envía en cuanto se lance. La hora es la de tu navegador y se guarda en UTC.',
  },
  'campaign.templateHint': {
    pt: 'Só modelos aprovados e publicados. Os de autenticação não servem para campanhas.',
    en: 'Approved and published templates only. Authentication templates have no bulk use.',
    es: 'Solo plantillas aprobadas y publicadas. Las de autenticación no sirven para envíos masivos.',
  },
  'campaign.source': {
    pt: 'Origem',
    en: 'Source',
    es: 'Origen',
  },
  'campaign.sourceView': {
    pt: 'Vista guardada de Pessoas',
    en: 'Saved People view',
    es: 'Vista guardada de Personas',
  },
  'campaign.sourceManual': {
    pt: 'Contactos escolhidos à mão',
    en: 'Hand-picked contacts',
    es: 'Contactos elegidos a mano',
  },
  'campaign.view': {
    pt: 'Vista',
    en: 'View',
    es: 'Vista',
  },
  // ─── The manual-audience contact picker (replaced the UUID textarea) ──────
  'campaign.personSearch': {
    pt: 'Procurar contactos',
    en: 'Search contacts',
    es: 'Buscar contactos',
  },
  'campaign.personSearchHint': {
    pt: 'Procure por nome ou por número de telefone e adicione um a um.',
    en: 'Search by name or phone number and add them one by one.',
    es: 'Búscalos por nombre o teléfono y agrégalos uno por uno.',
  },
  'campaign.personSearchPlaceholder': {
    pt: 'Nome ou telefone…',
    en: 'Name or phone…',
    es: 'Nombre o teléfono…',
  },
  'campaign.personNoResults': {
    pt: 'Nenhum contacto corresponde a “{query}”.',
    en: 'No contact matches “{query}”.',
    es: 'Ningún contacto coincide con «{query}».',
  },
  'campaign.personSelected': {
    pt: 'Audiência ({count})',
    en: 'Audience ({count})',
    es: 'Audiencia ({count})',
  },
  'campaign.personRemove': {
    pt: 'Remover da audiência',
    en: 'Remove from audience',
    es: 'Quitar de la audiencia',
  },
  'campaign.noVariables': {
    pt: 'Este modelo não tem variáveis.',
    en: 'This template has no variables.',
    es: 'Esta plantilla no tiene variables.',
  },
  'campaign.bindingField': {
    pt: 'Campo do contacto',
    en: 'Contact field',
    es: 'Campo del contacto',
  },
  'campaign.bindingStatic': {
    pt: 'Texto fixo',
    en: 'Fixed text',
    es: 'Texto fijo',
  },
  'campaign.field': {
    pt: 'Campo',
    en: 'Field',
    es: 'Campo',
  },
  'campaign.text': {
    pt: 'Texto',
    en: 'Text',
    es: 'Texto',
  },
  'campaign.fallback': {
    pt: 'Alternativa',
    en: 'Fallback',
    es: 'Valor de respaldo',
  },
  'campaign.fallbackHint': {
    pt: 'Usada quando o campo está vazio. Sem alternativa, o contacto é excluído.',
    en: 'Used when the field is empty. Without one, the contact is excluded.',
    es: 'Se usa cuando el campo está vacío. Sin él, el contacto queda excluido.',
  },
  'campaign.build': {
    pt: 'Construir audiência',
    en: 'Build audience',
    es: 'Armar audiencia',
  },
  'campaign.createdNoId': {
    pt: 'O servidor criou a campanha mas não devolveu o id.',
    en: 'The server created the campaign but returned no id.',
    es: 'El servidor creó la campaña pero no devolvió un identificador.',
  },

  'campaign.numbers': {
    pt: 'Números',
    en: 'Figures',
    es: 'Cifras',
  },
  'campaign.counter.recipientCount': {
    pt: 'Destinatários',
    en: 'Recipients',
    es: 'Destinatarios',
  },
  'campaign.counter.queuedCount': {
    pt: 'Em fila',
    en: 'Queued',
    es: 'En cola',
  },
  'campaign.counter.sentCount': {
    pt: 'Enviadas',
    en: 'Sent',
    es: 'Enviados',
  },
  'campaign.counter.deliveredCount': {
    pt: 'Entregues',
    en: 'Delivered',
    es: 'Entregados',
  },
  'campaign.counter.readCount': {
    pt: 'Lidas',
    en: 'Read',
    es: 'Leídos',
  },
  'campaign.counter.respondedCount': {
    pt: 'Respostas',
    en: 'Replies',
    es: 'Respuestas',
  },
  'campaign.counter.failedCount': {
    pt: 'Falhadas',
    en: 'Failed',
    es: 'Fallidos',
  },
  'campaign.counter.skippedCount': {
    pt: 'Ignoradas',
    en: 'Skipped',
    es: 'Omitidos',
  },
  'campaign.counter.excludedCount': {
    pt: 'Excluídas',
    en: 'Excluded',
    es: 'Excluidos',
  },
  'campaign.counter.actualCost': {
    pt: 'Custo real',
    en: 'Actual cost',
    es: 'Costo real',
  },

  'campaign.launch': {
    pt: 'Lançar',
    en: 'Launch',
    es: 'Lanzar',
  },
  'campaign.pause': {
    pt: 'Pausar',
    en: 'Pause',
    es: 'Pausar',
  },
  'campaign.resume': {
    pt: 'Retomar',
    en: 'Resume',
    es: 'Reanudar',
  },
  'campaign.cancel': {
    pt: 'Cancelar',
    en: 'Cancel',
    es: 'Cancelar',
  },
  'campaign.launchNeedsPreflight': {
    pt: 'A verificar destinatários e custo. O botão de lançamento aparece quando os números estiverem prontos.',
    en: 'Checking recipients and cost. The launch button appears once the numbers are ready.',
    es: 'Revisando destinatarios y costo. El botón de lanzar aparece cuando las cifras estén listas.',
  },
  /**
   * Names the number that explains it. "No recipients" alone invites a rebuild
   * of an audience that is not the problem — the contacts were found and then
   * excluded, and the exclusion breakdown below says by what.
   */
  'campaign.launchNoRecipients': {
    pt: 'Nenhum destinatário qualificado: {excluded} excluídos. Corrija os motivos abaixo e reconstrua a audiência.',
    en: 'No recipient qualifies: {excluded} excluded. Fix the reasons below and rebuild the audience.',
    es: 'Ningún destinatario califica: {excluded} excluidos. Corrige los motivos de abajo y vuelve a armar la audiencia.',
  },
  // `{cost}` arrives from `money()` with its own currency sign.
  'campaign.launchSubtitle': {
    pt: '{count} destinatários, ~{cost}',
    en: '{count} recipients, ~{cost}',
    es: '{count} destinatarios, ~{cost}',
  },
  'campaign.cancelSubtitle': {
    pt: 'As mensagens ainda não enviadas não serão enviadas.',
    en: 'Messages not yet sent will not be sent.',
    es: 'Los mensajes que todavía no salieron no se van a enviar.',
  },
  'campaign.delete': {
    pt: 'Eliminar campanha',
    en: 'Delete campaign',
    es: 'Eliminar campaña',
  },
  'campaign.deleteSubtitle': {
    pt: 'A campanha e a audiência que foi construída desaparecem da lista. Não há nada enviado para perder.',
    en: 'The campaign and the audience it built come off the list. There is nothing sent to lose.',
    es: 'La campaña y la audiencia que armó salen de la lista. No hay nada enviado que perder.',
  },
  'campaign.deleteNote': {
    pt: 'Esta campanha nunca foi lançada, por isso ainda pode ser eliminada. Depois do lançamento passa a ser o registo do que foi enviado — a partir daí só pode ser cancelada, nunca eliminada.',
    en: 'This campaign was never launched, so it can still be deleted. Once launched it becomes the record of what went out — from then on it can only be cancelled, never deleted.',
    es: 'Esta campaña nunca se lanzó, así que todavía se puede eliminar. Una vez lanzada se convierte en el registro de lo que salió: a partir de ahí solo se puede cancelar, nunca eliminar.',
  },
  'campaign.archive': {
    pt: 'Arquivar',
    en: 'Archive',
    es: 'Archivar',
  },
  'campaign.unarchive': {
    pt: 'Desarquivar',
    en: 'Unarchive',
    es: 'Desarchivar',
  },
  'campaign.archiveTitle': {
    pt: 'Arquivo',
    en: 'Archive',
    es: 'Archivar',
  },
  'campaign.archivedOn': {
    pt: 'Arquivada {when} — está fora da lista de campanhas, mas continua a receber estados de entrega e respostas.',
    en: 'Archived {when} — off the campaigns list, but still receiving delivery statuses and replies.',
    es: 'Archivada {when}: fuera de la lista de campañas, pero sigue recibiendo estados de entrega y respuestas.',
  },
  'campaign.archiveNone': {
    pt: 'O arquivo está vazio.',
    en: 'The archive is empty.',
    es: 'El archivo está vacío.',
  },
  'campaign.archiveNoneBody': {
    pt: 'As campanhas concluídas, canceladas ou falhadas podem ser arquivadas a partir da própria campanha. Nada é apagado: sai da lista e volta quando quiser.',
    en: 'Completed, cancelled or failed campaigns can be archived from the campaign itself. Nothing is deleted: it leaves the list and comes back whenever you want.',
    es: 'Las campañas completadas, canceladas o fallidas se pueden archivar desde la campaña misma. No se borra nada: sale de la lista y vuelve cuando quieras.',
  },
  'campaign.archiveBack': {
    pt: 'Voltar às campanhas',
    en: 'Back to campaigns',
    es: 'Volver a campañas',
  },
  'campaign.reason': {
    pt: 'Motivo',
    en: 'Reason',
    es: 'Motivo',
  },
  'campaign.pacing': {
    pt: 'O ritmo foi reduzido para respeitar o limite do número — a campanha demora mais do que o previsto, e nada foi perdido.',
    en: 'The pace was reduced to respect the number’s limit — the campaign takes longer than planned, and nothing was lost.',
    es: 'El ritmo se redujo para respetar el límite del número: la campaña tarda más de lo planeado, y no se perdió nada.',
  },

  'campaign.preflightAudience': {
    pt: 'Pré-voo — audiência',
    en: 'Pre-flight — audience',
    es: 'Previo al envío: audiencia',
  },
  'campaign.preflightCost': {
    pt: 'Pré-voo — custo e limite',
    en: 'Pre-flight — cost and limit',
    es: 'Previo al envío: costo y límite',
  },
  'campaign.preflightQuality': {
    pt: 'Pré-voo — qualidade e modelo',
    en: 'Pre-flight — quality and template',
    es: 'Previo al envío: calidad y plantilla',
  },
  'campaign.preflightPreview': {
    pt: 'Pré-voo — como fica',
    en: 'Pre-flight — how it reads',
    es: 'Previo al envío: cómo se lee',
  },
  'campaign.willReceive': {
    pt: 'Vão receber',
    en: 'Will receive',
    es: 'Van a recibir',
  },
  'campaign.excluded': {
    pt: 'Excluídos',
    en: 'Excluded',
    es: 'Excluidos',
  },
  // Both values arrive from `money()` with their own currency sign.
  'campaign.perMessage': {
    pt: '~{total} a {rate} por mensagem',
    en: '~{total} at {rate} per message',
    es: '~{total} a {rate} por mensaje',
  },
  'campaign.tierLine': {
    pt: 'Escalão {tier}: {used} usados de {limit}, {reserve} reservados para conversas 1:1 — {available} disponíveis hoje.',
    en: 'Tier {tier}: {used} used of {limit}, {reserve} reserved for 1:1 conversations — {available} available today.',
    es: 'Tier {tier}: {used} usados de {limit}, {reserve} reservados para conversaciones uno a uno — {available} disponibles hoy.',
  },
  'campaign.spreadFits': {
    pt: 'Cabe tudo no dia de hoje.',
    en: 'It all fits in today.',
    es: 'Todo cabe hoy.',
  },
  'campaign.spreadDays': {
    pt: '{firstDay} hoje, e o resto ao longo de {days} dias — o escalão diário não chega para a audiência toda.',
    en: '{firstDay} today, and the rest over {days} days — the daily tier does not cover the whole audience.',
    es: '{firstDay} hoy, y el resto a lo largo de {days} días: el tier diario no alcanza para toda la audiencia.',
  },
  'campaign.quality': {
    pt: 'Qualidade',
    en: 'Quality',
    es: 'Calidad',
  },
  'campaign.acknowledge': {
    pt: 'Reconheço a classificação e quero lançar mesmo assim',
    en: 'I acknowledge the rating and want to launch anyway',
    es: 'Reconozco la calificación y quiero lanzar de todos modos',
  },
  'campaign.launchAnyway': {
    pt: 'Lançar mesmo assim',
    en: 'Launch anyway',
    es: 'Lanzar de todos modos',
  },
  'campaign.testSend': {
    pt: 'Envio de teste',
    en: 'Test send',
    es: 'Envío de prueba',
  },
  'campaign.recipientsSample': {
    pt: 'Destinatários (amostra de {count})',
    en: 'Recipients (sample of {count})',
    es: 'Destinatarios (muestra de {count})',
  },

  // ─── Settings ─────────────────────────────────────────────────────────────
  'settings.tab.connection': {
    pt: 'Ligação',
    en: 'Connection',
    es: 'Conexión',
  },
  'settings.tab.health': {
    pt: 'Saúde',
    en: 'Health',
    es: 'Salud',
  },
  'settings.tab.templates': {
    pt: 'Modelos',
    en: 'Templates',
    es: 'Plantillas',
  },
  'settings.tab.variables': {
    pt: 'Variáveis',
    en: 'Variables',
    es: 'Variables',
  },
  'settings.tab.diagnostics': {
    pt: 'Diagnóstico',
    en: 'Diagnostics',
    es: 'Diagnóstico',
  },
  'settings.variablesNote': {
    pt: 'Definições da aplicação. As palavras-chave e o texto das confirmações estão aqui de propósito: mudá-los é uma edição, nunca um deploy.',
    en: 'Application settings. The keywords and the confirmation wording live here on purpose: changing them is an edit, never a deploy.',
    es: 'Ajustes de la aplicación. Las palabras clave y los textos de confirmación viven aquí a propósito: cambiarlos es una edición, nunca un despliegue.',
  },
  'settings.variableSaved': {
    pt: '{key} guardada',
    en: '{key} saved',
    es: '{key} guardada',
  },
  'settings.variableEdited': {
    pt: 'alterada',
    en: 'edited',
    es: 'editada',
  },
  /**
   * The bar lists the keys beside this count. A single Save that commits a
   * throttle and a legal sentence together is only acceptable if the operator
   * can see that is what it is about to do (D-68).
   */
  'settings.unsavedChanges': {
    pt: '{count} alteração(ões) por guardar',
    en: '{count} unsaved change(s)',
    es: '{count} cambio(s) sin guardar',
  },
  'settings.saveChanges': {
    pt: 'Guardar {count}',
    en: 'Save {count}',
    es: 'Guardar {count}',
  },
  // The sections the variables are grouped into, named by what they affect.
  'settings.variableSection.connection': {
    pt: 'Ligação à Meta',
    en: 'Meta connection',
    es: 'Conexión con Meta',
  },
  'settings.variableSection.sending': {
    pt: 'Envio e ritmo',
    en: 'Sending and pacing',
    es: 'Envío y ritmo',
  },
  'settings.variableSection.window': {
    pt: 'Janela de serviço',
    en: 'Service window',
    es: 'Ventana de servicio',
  },
  'settings.variableSection.consent': {
    pt: 'Consentimento e confirmações',
    en: 'Consent and confirmations',
    es: 'Consentimiento y confirmaciones',
  },
  'settings.variableSection.campaigns': {
    pt: 'Campanhas',
    en: 'Campaigns',
    es: 'Campañas',
  },
  'settings.variableSection.templates': {
    pt: 'Modelos',
    en: 'Templates',
    es: 'Plantillas',
  },
  'settings.variableSection.media': {
    pt: 'Ficheiros',
    en: 'Media',
    es: 'Multimedia',
  },
  'settings.variableSection.retention': {
    pt: 'Retenção e cronologia',
    en: 'Retention and timeline',
    es: 'Retención y cronología',
  },
  'settings.variableSection.billing': {
    pt: 'Tarifas',
    en: 'Rates',
    es: 'Tarifas',
  },
  'settings.variableSection.interface': {
    pt: 'Interface',
    en: 'Interface',
    es: 'Interfaz',
  },
  'settings.variableSection.access': {
    pt: 'Acessos',
    en: 'Access',
    es: 'Acceso',
  },
  'settings.variableSection.other': {
    pt: 'Outras',
    en: 'Other',
    es: 'Otros',
  },

  'settings.summary': {
    pt: '{displayName} · qualidade {quality} · escalão {tier}',
    en: '{displayName} · quality {quality} · tier {tier}',
    es: '{displayName} · calidad {quality} · tier {tier}',
  },
  'settings.test': {
    pt: 'Testar ligação',
    en: 'Test connection',
    es: 'Probar conexión',
  },
  'settings.tested': {
    pt: 'Ligação testada.',
    en: 'Connection tested.',
    es: 'Conexión probada.',
  },
  'settings.syncTemplates': {
    pt: 'Sincronizar modelos',
    en: 'Sync templates',
    es: 'Sincronizar plantillas',
  },
  'settings.syncRequested': {
    pt: 'Sincronização pedida.',
    en: 'Sync requested.',
    es: 'Sincronización solicitada.',
  },
  'settings.saved': {
    pt: 'Guardado.',
    en: 'Saved.',
    es: 'Guardado.',
  },
  'settings.disconnect': {
    pt: 'Desligar',
    en: 'Disconnect',
    es: 'Desconectar',
  },
  'settings.dangerZone': {
    pt: 'Zona de perigo',
    en: 'Danger zone',
    es: 'Zona de riesgo',
  },
  'settings.disconnectWarning': {
    pt: 'Desligar este número pára o envio e a recepção de mensagens WhatsApp neste espaço de trabalho até que volte a ser ligado.',
    en: 'Disconnecting this number stops sending and receiving WhatsApp messages in this workspace until it is connected again.',
    es: 'Desconectar este número detiene el envío y la recepción de mensajes de WhatsApp en este espacio de trabajo hasta que se vuelva a conectar.',
  },
  'settings.disconnectConfirm': {
    pt: 'Confirmar e desligar',
    en: 'Confirm disconnect',
    es: 'Confirmar desconexión',
  },
  'settings.connectTitle': {
    pt: 'Ligar um número',
    en: 'Connect a number',
    es: 'Conectar un número',
  },
  'settings.connect': {
    pt: 'Ligar',
    en: 'Connect',
    es: 'Conectar',
  },
  'settings.name': {
    pt: 'Nome',
    en: 'Name',
    es: 'Nombre',
  },
  'settings.phoneNumberIdHint': {
    pt: 'Meta → WhatsApp → API Setup.',
    en: 'Meta → WhatsApp → API Setup.',
    es: 'Meta → WhatsApp → API Setup.',
  },
  'settings.callingCode': {
    pt: 'Indicativo por omissão',
    en: 'Default calling code',
    es: 'Lada por omisión',
  },
  /**
   * The field sits under `phone_number_id` and `WABA id`, both of which take
   * long numbers, and operators pasted the whole display number into it. The
   * counter-example is doing the work here — "1-3 digits" alone did not stop
   * anyone.
   */
  'settings.callingCodeHint': {
    pt: 'Só o indicativo do país (1 a 3 dígitos), p. ex. +244 — não o número completo.',
    en: 'The country code only (1–3 digits), e.g. +244 — not the full phone number.',
    es: 'Solo el código de país (1 a 3 dígitos), por ejemplo +52 — no el número completo.',
  },
  'settings.callingCodeInherited': {
    pt: 'herda WA_DEFAULT_COUNTRY_CALLING_CODE',
    en: 'inherits WA_DEFAULT_COUNTRY_CALLING_CODE',
    es: 'hereda WA_DEFAULT_COUNTRY_CALLING_CODE',
  },
  'settings.isTestAccount': {
    pt: 'É um número de teste',
    en: 'This is a test number',
    es: 'Este es un número de prueba',
  },

  'settings.callback': {
    pt: 'Callback da Meta',
    en: 'Meta callback',
    es: 'Callback de Meta',
  },
  'settings.callbackUrl': {
    pt: 'URL do callback (alias legado no proxy)',
    en: 'Callback URL (legacy proxy alias)',
    es: 'URL de callback (alias heredado de proxy)',
  },
  /**
   * The sentence that was missing — updated when the resolver began answering
   * the GET handshake itself: the direct form **is** the callback, and the
   * alias is only a fallback for a Twenty that does not route GET to server
   * routes.
   */
  'settings.callbackDirectNote': {
    pt: 'A Meta usa um só URL para o GET de verificação e para os POST de eventos. Cole acima a forma directa — responde a ambos. O alias no proxy e o URL de verificação são alternativas legadas para versões do Twenty que não encaminham GET para rotas de servidor.',
    en: 'Meta uses a single URL for both the GET verification and the POST events. Paste the direct form above — it answers both. The proxy alias and the verification URL are legacy alternatives for Twenty versions that do not route GET to server routes.',
    es: 'Meta usa una sola URL para la verificación GET y para los eventos POST. Pega arriba la forma directa: responde a ambas. El alias de proxy y la URL de verificación son alternativas heredadas para versiones de Twenty que no enrutan GET a rutas de servidor.',
  },
  /**
   * Shown only when the server's own address is local. The path is
   * interpolated rather than written out so the sentence cannot drift from the
   * URL printed under it.
   */
  'settings.callbackLocalNote': {
    pt: 'Estes endereços são locais desta máquina — a Meta não os consegue alcançar. No Meta, use o URL público do seu túnel (ngrok, cloudflared, …) com o mesmo caminho {path}.',
    en: 'These addresses are local to this machine — Meta cannot reach them. In Meta, use your public tunnel URL (ngrok, cloudflared, …) with the same {path} path.',
    es: 'Estas direcciones son locales de esta máquina: Meta no puede alcanzarlas. En Meta usa la URL pública de tu túnel (ngrok, cloudflared, …) con la misma ruta {path}.',
  },
  'settings.directUrl': {
    pt: 'URL do callback (directo — GET e POST)',
    en: 'Callback URL (direct — GET and POST)',
    es: 'URL de callback (directa: GET y POST)',
  },
  'settings.verifyUrl': {
    pt: 'URL de verificação (GET, legado)',
    en: 'Verification URL (GET, legacy)',
    es: 'URL de verificación (GET, heredado)',
  },
  'settings.verifyToken': {
    pt: 'Token de verificação',
    en: 'Verify token',
    es: 'Token de verificación',
  },
  'settings.verifyTokenSet': {
    pt: 'configurado na variável de servidor META_VERIFY_TOKEN',
    en: 'configured in the META_VERIFY_TOKEN server variable',
    es: 'configurado en la variable de servidor META_VERIFY_TOKEN',
  },
  /**
   * The warning mark used to live in the string. It is an icon in the
   * component now, so the sentence is only a sentence — a translator changing
   * the wording can no longer delete the alert by accident.
   */
  'settings.verifyTokenMissing': {
    pt: 'em falta — defina META_VERIFY_TOKEN',
    en: 'missing — set META_VERIFY_TOKEN',
    es: 'falta: configura META_VERIFY_TOKEN',
  },
  'settings.requiredFields': {
    pt: 'Campos a subscrever',
    en: 'Fields to subscribe',
    es: 'Campos a suscribir',
  },
  'settings.copyFields': {
    pt: 'Copiar lista de campos',
    en: 'Copy the field list',
    es: 'Copiar la lista de campos',
  },

  'settings.health.token': {
    pt: 'Token de acesso',
    en: 'Access token',
    es: 'Token de acceso',
  },
  'settings.health.token.remedy': {
    pt: 'A verificação horária não corre há mais de duas horas, ou falhou. Veja specs/11 §2.',
    en: 'The hourly check has not run for over two hours, or it failed. See specs/11 §2.',
    es: 'La revisión horaria no corre desde hace más de dos horas, o falló. Ver specs/11 §2.',
  },
  'settings.health.webhook': {
    pt: 'Webhook',
    en: 'Webhook',
    es: 'Webhook',
  },
  'settings.health.webhook.remedy': {
    pt: 'Não chegam eventos há mais tempo do que o limite. Confirme a subscrição na Meta.',
    en: 'No events for longer than the threshold. Check the subscription at Meta.',
    es: 'Sin eventos por más tiempo del umbral. Revisa la suscripción en Meta.',
  },
  'settings.health.quality': {
    pt: 'Qualidade do número',
    en: 'Number quality',
    es: 'Calidad del número',
  },
  'settings.health.quality.remedy': {
    pt: 'A Meta baixou a classificação. Reduza envios de marketing e reveja os modelos.',
    en: 'Meta lowered the rating. Cut marketing sends and review the templates.',
    es: 'Meta bajó la calificación. Reduce los envíos de marketing y revisa las plantillas.',
  },
  'settings.health.tier': {
    pt: 'Escalão diário',
    en: 'Daily tier',
    es: 'Tier diario',
  },
  'settings.health.tier.remedy': {
    pt: 'A reserva para conversas 1:1 já consumiu o que resta — nenhuma campanha arranca hoje.',
    en: 'The 1:1 reserve has taken what is left — no campaign starts today.',
    es: 'La reserva de conversaciones uno a uno se llevó lo que quedaba: hoy no arranca ninguna campaña.',
  },
  'settings.health.failedWebhookEvents': {
    pt: 'Entregas falhadas (24h)',
    en: 'Failed deliveries (24h)',
    es: 'Entregas fallidas (24 h)',
  },
  'settings.health.failedWebhookEvents.remedy': {
    pt: 'Há eventos por processar. Veja o separador Diagnóstico.',
    en: 'There are unprocessed events. See the Diagnostics tab.',
    es: 'Hay eventos sin procesar. Ve a la pestaña de Diagnóstico.',
  },
  'settings.templateQuality': {
    pt: 'Qualidade {score}',
    en: 'Quality {score}',
    es: 'Calidad {score}',
  },
  'settings.health.detail.tokenNever': {
    pt: 'Nunca verificado',
    en: 'Never checked',
    es: 'Nunca revisado',
  },
  'settings.health.detail.tokenChecked': {
    pt: 'Verificado {when}',
    en: 'Checked {when}',
    es: 'Revisado {when}',
  },
  'settings.health.detail.webhookNone': {
    pt: 'Ainda sem eventos recebidos',
    en: 'No events received yet',
    es: 'Todavía no se reciben eventos',
  },
  'settings.health.detail.webhookLast': {
    pt: 'Último evento {when}',
    en: 'Last event {when}',
    es: 'Último evento {when}',
  },
  'settings.health.detail.quality': {
    pt: 'Classificação {rating}',
    en: 'Rated {rating}',
    es: 'Calificado {rating}',
  },
  /** `UNKNOWN` means "no data yet". Saying "Rated UNKNOWN" invents a grade. */
  'settings.health.detail.qualityUngraded': {
    pt: 'A Meta ainda não classificou este número.',
    en: 'Meta has not rated this number yet.',
    es: 'Meta todavía no ha calificado este número.',
  },
  'settings.health.detail.tier': {
    pt: '{available} envios disponíveis hoje de {limit}, com {reserve} reservados para conversas 1:1',
    en: '{available} sends available today of {limit}, with {reserve} held back for 1:1 conversations',
    es: '{available} envíos disponibles hoy de {limit}, con {reserve} apartados para conversaciones uno a uno',
  },
  'settings.health.detail.none': {
    pt: 'Nenhuma',
    en: 'None',
    es: 'Ninguno',
  },
  'settings.health.detail.count': {
    pt: '{count}',
    en: '{count}',
    es: '{count}',
  },
  'settings.health.detail.stuck': {
    pt: '{count} há mais de {minutes} minutos',
    en: '{count} for more than {minutes} minutes',
    es: '{count} por más de {minutes} minutos',
  },
  'settings.health.stuckOutbound': {
    pt: 'Mensagens presas',
    en: 'Stuck messages',
    es: 'Mensajes atorados',
  },
  'settings.health.stuckOutbound.remedy': {
    pt: 'Mensagens em fila há mais de 15 minutos. A verificação horária volta a tentar.',
    en: 'Messages queued for over 15 minutes. The hourly check retries them.',
    es: 'Mensajes en cola por más de 15 minutos. La revisión horaria los reintenta.',
  },
  'settings.health.failedOutbound': {
    pt: 'Envios falhados (24h)',
    en: 'Failed sends (24h)',
    es: 'Envíos fallidos (24 h)',
  },
  'settings.health.failedOutbound.remedy': {
    pt: 'Mensagens que não chegaram ao destinatário. O motivo de cada uma está no separador Diagnóstico.',
    en: 'Messages that never reached the recipient. Each one’s reason is in the Diagnostics tab.',
    es: 'Mensajes que nunca llegaron al destinatario. El motivo de cada uno está en la pestaña de Diagnóstico.',
  },
  'settings.health.consentWording': {
    pt: 'Textos de consentimento',
    en: 'Consent wording',
    es: 'Textos de consentimiento',
  },
  'settings.health.consentWording.remedy': {
    pt: 'A confirmação manda o contacto responder uma palavra que já não está na lista de palavras-chave. Reponha a palavra na lista, ou use {optOutKeyword} / {optInKeyword} no texto para que acompanhe sempre a lista.',
    en: 'The confirmation tells the contact to reply a word that is no longer in the keyword list. Put the word back, or use {optOutKeyword} / {optInKeyword} in the text so it always follows the list.',
    es: 'La confirmación le pide al contacto que responda una palabra que ya no está en la lista de palabras clave. Vuelve a ponerla, o usa {optOutKeyword} / {optInKeyword} en el texto para que siempre siga la lista.',
  },
  'settings.health.detail.consentWordingOk': {
    pt: 'As confirmações e as listas de palavras-chave concordam.',
    en: 'The confirmations and the keyword lists agree.',
    es: 'Las confirmaciones y las listas de palabras clave concuerdan.',
  },
  'settings.health.detail.consentWording': {
    pt: 'Já não é reconhecida: {words}',
    en: 'No longer recognised: {words}',
    es: 'Ya no se reconoce: {words}',
  },
  'settings.needsAdminRole': {
    pt: 'Precisa da função de administrador do WhatsApp para alterar seja o que for nesta página. Pode ler; as acções estão desactivadas.',
    en: 'Changing anything on this page needs the WhatsApp admin role. You can read it; the actions are disabled.',
    es: 'Cambiar algo en esta página requiere el rol de administrador de WhatsApp. Puedes leerla; las acciones están deshabilitadas.',
  },
  'settings.ok': {
    pt: 'OK',
    en: 'OK',
    es: 'Bien',
  },
  'settings.needsAttention': {
    pt: 'a precisar de atenção',
    en: 'needs attention',
    es: 'requiere atención',
  },

  'settings.noTemplates': {
    pt: 'Nenhum modelo sincronizado.',
    en: 'No templates synced.',
    es: 'No hay plantillas sincronizadas.',
  },
  'settings.publish': {
    pt: 'Publicar',
    en: 'Publish',
    es: 'Publicar',
  },
  'settings.unpublish': {
    pt: 'Despublicar',
    en: 'Unpublish',
    es: 'Despublicar',
  },
  'settings.published': {
    pt: 'Publicado',
    en: 'Published',
    es: 'Publicada',
  },
  'settings.notPublished': {
    pt: 'Não publicado',
    en: 'Not published',
    es: 'Sin publicar',
  },
  'settings.templateFilter.all': {
    pt: 'Todos',
    en: 'All',
    es: 'Todas',
  },
  'settings.templateFilter.published': {
    pt: 'Publicados',
    en: 'Published',
    es: 'Publicadas',
  },
  'settings.templateFilter.unpublished': {
    pt: 'Por publicar',
    en: 'Unpublished',
    es: 'Sin publicar',
  },

  'settings.failedEvents': {
    pt: 'Entregas falhadas (24h)',
    en: 'Failed deliveries (24h)',
    es: 'Entregas fallidas (24 h)',
  },
  'settings.stuckMessages': {
    pt: 'Mensagens presas',
    en: 'Stuck messages',
    es: 'Mensajes atorados',
  },
  /**
   * Distinct from "Entregas falhadas", which is *inbound* — webhook events we
   * could not process. A rep reporting "my photo did not send" is asking about
   * this list, and until D-65 there was no list to look at.
   */
  'settings.failedOutbound': {
    pt: 'Envios falhados (24h)',
    en: 'Failed sends (24h)',
    es: 'Envíos fallidos (24 h)',
  },
  'settings.attempts': {
    pt: 'tentativas',
    en: 'attempts',
    es: 'intentos',
  },
  'settings.replay': {
    pt: 'Reprocessar',
    en: 'Replay',
    es: 'Reprocesar',
  },
  'settings.replaySelected': {
    pt: 'Reprocessar seleccionadas ({count})',
    en: 'Replay selected ({count})',
    es: 'Reprocesar los seleccionados ({count})',
  },
  'settings.replayAllFailed': {
    pt: 'Reprocessar todas as falhadas',
    en: 'Replay all failed',
    es: 'Reprocesar todos los fallidos',
  },
  'settings.replayConfirm': {
    pt: 'Reprocessar {count} entregas? É seguro repetir: cada processador é idempotente pelo WAMID.',
    en: 'Replay {count} deliveries? Repeating is safe: every processor is idempotent on the WAMID.',
    es: '¿Reprocesar {count} entregas? Repetir es seguro: cada procesador es idempotente por WAMID.',
  },
  'settings.replayDone': {
    pt: '{replayed} de {requested} reprocessadas, {jobs} tarefas na fila.',
    en: '{replayed} of {requested} replayed, {jobs} jobs queued.',
    es: '{replayed} de {requested} reprocesadas, {jobs} trabajos en cola.',
  },
  'settings.replayTruncated': {
    pt: 'Ainda faltam entregas: o limite por pedido é {cap}. Volte a carregar para continuar.',
    en: 'Deliveries are left over: the per-request cap is {cap}. Press again to continue.',
    es: 'Quedan entregas pendientes: el tope por petición es {cap}. Vuelve a pulsar para continuar.',
  },
  'settings.replayNothing': {
    pt: 'Nenhuma entrega falhada para reprocessar.',
    en: 'No failed delivery to replay.',
    es: 'No hay ninguna entrega fallida que reprocesar.',
  },
  'settings.replayNote': {
    pt: 'A Meta reenvia um webhook durante 7 dias e não tem endpoint de reposição, por isso este registo é a única origem para reprocessar. Reprocessar é seguro: nada é duplicado.',
    en: 'Meta retries a webhook for 7 days and offers no replay endpoint, so this log is the only source for reprocessing. Replaying is safe: nothing is duplicated.',
    es: 'Meta reintenta un webhook durante 7 días y no ofrece un endpoint para reprocesar, así que este registro es la única fuente. Reprocesar es seguro: no se duplica nada.',
  },
  'settings.notifications': {
    pt: 'Notificações',
    en: 'Notifications',
    es: 'Notificaciones',
  },
  'settings.notificationsNote': {
    pt: 'As mensagens por ler e o aviso ao vivo chegam a quem está a olhar para o Twenty. Para chegar a quem não está, é preciso um fluxo de trabalho: este botão cria-o em rascunho, com o gatilho já ligado a uma mensagem nova de WhatsApp.',
    en: 'Unread counts and the live toast reach whoever is looking at Twenty. Reaching someone who is not takes a workflow: this button creates one as a draft, with the trigger already wired to a new WhatsApp message.',
    es: 'Los contadores de no leídos y el aviso en vivo le llegan a quien esté mirando Twenty. Alcanzar a quien no lo está requiere un flujo de trabajo: este botón crea uno como borrador, con el disparador ya conectado a un mensaje nuevo de WhatsApp.',
  },
  'settings.createNotificationWorkflow': {
    pt: 'Criar o fluxo de notificação',
    en: 'Create the notification workflow',
    es: 'Crear el flujo de notificación',
  },
  'settings.notificationWorkflowCreated': {
    pt: 'Rascunho criado: “{name}”. Abra-o em Fluxos de trabalho para o rever e activar.',
    en: 'Draft created: “{name}”. Open it under Workflows to review and activate it.',
    es: 'Borrador creado: «{name}». Ábrelo en Flujos de trabajo para revisarlo y activarlo.',
  },
  'settings.notificationWorkflowExisted': {
    pt: 'Já existe: “{name}”. Nada foi alterado.',
    en: 'It already exists: “{name}”. Nothing was changed.',
    es: 'Ya existe: «{name}». No se cambió nada.',
  },
  'settings.review.FILTER_INBOUND': {
    pt: 'Filtre o gatilho por direcção = INBOUND — sem isso, cada mensagem que um agente envia cria uma tarefa a pedir-lhe que responda a si próprio.',
    en: 'Filter the trigger to direction = INBOUND — without it, every message a rep sends creates a task asking them to reply to themselves.',
    es: 'Filtra el disparador a direction = INBOUND. Sin eso, cada mensaje que envíe un agente crea una tarea pidiéndole que se responda a sí mismo.',
  },
  'settings.review.CHOOSE_ASSIGNEE': {
    pt: 'Escolha quem recebe a tarefa: o responsável da conversa, ou uma pessoa fixa.',
    en: 'Choose who gets the task: the conversation’s assignee, or a fixed person.',
    es: 'Elige quién recibe la tarea: el responsable de la conversación, o una persona fija.',
  },
  'settings.review.ACTIVATE': {
    pt: 'Active o fluxo. Fica em rascunho até o fazer.',
    en: 'Activate the workflow. It stays a draft until you do.',
    es: 'Activa el flujo. Hasta que lo hagas, se queda en borrador.',
  },
  'settings.consent': {
    pt: 'Consentimento',
    en: 'Consent',
    es: 'Consentimiento',
  },
  'settings.consentNote': {
    pt: 'As palavras-chave de subscrição e cancelamento, e o texto da confirmação, são variáveis da aplicação — edite-as no separador Variáveis, aqui ao lado. Não são código de propósito: o texto é revisto por aconselhamento jurídico e uma alteração não deve exigir um deploy.',
    en: 'The opt-in and opt-out keywords, and the confirmation wording, are application variables — edit them in the Variables tab, next to this one. They are deliberately not code: the wording is reviewed by counsel, and a change must never require a deploy.',
    es: 'Las palabras clave de alta y baja, y los textos de confirmación, son variables de la aplicación: edítalas en la pestaña de Variables, junto a esta. A propósito no son código: los textos los revisa el área legal, y un cambio nunca debe exigir un despliegue.',
  },
} satisfies Record<string, Entry>;

export type CopyKey = keyof typeof COPY;

type Table = Record<string, string>;

const tableFor = (lang: Lang): Table =>
  Object.fromEntries(Object.entries(COPY).map(([key, entry]) => [key, entry[lang]]));

export const TABLES: Record<Lang, Table> = {
  pt: tableFor('pt'),
  en: tableFor('en'),
  es: tableFor('es'),
};

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
