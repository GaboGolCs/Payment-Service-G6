const API_BASE = window.location.origin + '/api/payments';

function statusMeta(status) {
  switch (status) {
    case 'APPROVED':
      return { cls: 'status-approved', badge: 'badge-approved', icon: '✓', title: '¡Pago aprobado!', sub: 'La transacción se completó correctamente.' };
    case 'REJECTED':
      return { cls: 'status-rejected', badge: 'badge-rejected', icon: '✕', title: 'Pago rechazado', sub: 'La transacción no pudo completarse.' };
    default:
      return { cls: 'status-pending', badge: 'badge-pending', icon: '⏳', title: 'Pago pendiente', sub: 'Estamos esperando la confirmación de Mercado Pago.' };
  }
}

function renderResult(payment) {
  const meta = statusMeta(payment.status);
  const view = document.getElementById('result-view');
  view.className = 'card ' + meta.cls;
  view.innerHTML = `
    <div class="status-icon">${meta.icon}</div>
    <h2 class="result-title">${meta.title}</h2>
    <p class="result-sub">${meta.sub}</p>
    <div class="detail-row"><span>Estado</span><span class="badge ${meta.badge}">${payment.status}</span></div>
    <div class="detail-row"><span>Monto</span><span>${payment.currency} $${payment.amount.toLocaleString('es-CL')}</span></div>
    <div class="detail-row"><span>ID de pago</span><span>${payment.id.slice(0, 13)}…</span></div>
    <div class="detail-row"><span>Order ID</span><span>${(payment.orderId || '—').slice(0, 24)}</span></div>
    <button onclick="goHome()">Hacer otro pago de prueba</button>
    <p class="footer-note">FishMarket — Checkout Pro (Mercado Pago)</p>
  `;
  view.style.display = 'block';
  document.getElementById('loading-view').style.display = 'none';
  document.getElementById('error-view').style.display = 'none';
}

function renderPollingTimeout(paymentId) {
  const token = sessionStorage.getItem('demoToken');
  const view = document.getElementById('result-view');
  view.className = 'card status-pending';
  view.innerHTML = `
    <div class="status-icon">⏳</div>
    <h2 class="result-title">Aún procesando</h2>
    <p class="result-sub">Mercado Pago todavía no confirma el estado final. Puedes reintentar la consulta, o simular la confirmación manualmente (backoffice).</p>
    <button onclick="pollPaymentStatus('${paymentId}')">Reintentar consulta</button>
    ${token ? `<button onclick="confirmPaymentManually('${paymentId}')" style="background:var(--pending); margin-top:10px;">Simular confirmación (backoffice)</button>` : ''}
    <button class="secondary" onclick="goHome()" style="margin-top:10px;">Volver al inicio</button>
  `;
  view.style.display = 'block';
  document.getElementById('loading-view').style.display = 'none';
}

function renderNoPaymentFound() {
  document.getElementById('loading-view').style.display = 'none';
  const err = document.getElementById('error-view');
  err.innerHTML = `
    <div class="status-icon status-rejected"></div>
    <h2 class="result-title">No encontramos el pago</h2>
    <p class="result-sub">No llegó un identificador de pago válido en la URL de retorno.</p>
    <button onclick="goHome()">Volver al inicio</button>
  `;
  err.style.display = 'block';
}

async function confirmPaymentManually(paymentId) {
  const token = sessionStorage.getItem('demoToken');
  try {
    const res = await fetch(API_BASE + '/' + paymentId + '/confirm', {
      method: 'POST',
      headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    });
    const payment = await res.json();
    if (!res.ok) {
      renderNoPaymentFound();
      return;
    }
    renderResult(payment);
  } catch (err) {
    renderNoPaymentFound();
  }
}

async function pollPaymentStatus(paymentId, attempt = 0) {
  document.getElementById('loading-view').style.display = 'block';
  document.getElementById('result-view').style.display = 'none';
  document.getElementById('error-view').style.display = 'none';
  try {
    const res = await fetch(API_BASE + '/' + paymentId);
    if (!res.ok) {
      renderNoPaymentFound();
      return;
    }
    const payment = await res.json();
    if (payment.status === 'PENDING' && attempt < 5) {
      // Reintenta cada 2s por si el webhook aún no llega (máx ~10s)
      setTimeout(() => pollPaymentStatus(paymentId, attempt + 1), 2000);
      return;
    }
    if (payment.status === 'PENDING') {
      renderPollingTimeout(paymentId);
      return;
    }
    renderResult(payment);
  } catch (err) {
    renderNoPaymentFound();
  }
}

function goHome() {
  window.location.href = '/pay.html';
}

// Punto de entrada común para success/failure/pending.html:
// Mercado Pago redirige con ?external_reference=<paymentId> (además de otros
// query params propios de MP). Nunca confiamos en el status de la URL —
// siempre reconsultamos el estado real contra nuestra propia API.
function initResultPage() {
  const params = new URLSearchParams(window.location.search);
  const externalRef = params.get('external_reference');
  const savedId = sessionStorage.getItem('demoPaymentId');
  const paymentId = externalRef || savedId;

  if (!paymentId) {
    renderNoPaymentFound();
    return;
  }
  pollPaymentStatus(paymentId);
}
