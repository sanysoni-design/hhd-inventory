import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, AlertTriangle, BadgeCheck, Building2, Camera, CheckCircle2,
  ChevronRight, Package, RefreshCw, ScanLine, ShieldAlert, UserRound,
} from 'lucide-react';
import { operationsApi } from './operationsApi.js';
import './hoto-wizard.css';

const localDate = () => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};
const localDateTime = () => new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const text = (value) => String(value ?? '').trim();
const pretty = (value) => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function HotoScanField({ id, label, value, onChange, placeholder, onSubmit, busy }) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const inputRef = useRef(null);
  const videoRef = useRef(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    inputRef.current?.focus();
  }, [id]);

  useEffect(() => {
    if (!cameraOpen) return undefined;
    let active = true;
    let stream = null;
    let frame = null;
    const close = () => {
      if (frame) cancelAnimationFrame(frame);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    const start = async () => {
      try {
        if (!('BarcodeDetector' in window)) throw new Error('Camera scanning is not supported in this browser. Use a USB/Bluetooth scanner or enter the value manually.');
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera scanning requires HTTPS and camera permission.');
        const detector = new window.BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code', 'upc_a', 'upc_e', 'itf'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
        if (!active) { stream.getTracks().forEach((track) => track.stop()); return; }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const scan = async () => {
          if (!active || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            if (found?.[0]?.rawValue) {
              changeRef.current(found[0].rawValue);
              setCameraOpen(false);
              return;
            }
          } catch (error) {
            setCameraError(error.message || 'Could not read this barcode.');
          }
          if (active) frame = requestAnimationFrame(scan);
        };
        scan();
      } catch (error) {
        setCameraError(error.message || 'Camera could not be started.');
        setCameraOpen(false);
      }
    };
    start();
    return () => { active = false; close(); };
  }, [cameraOpen]);

  return (
    <div className="hw-scan">
      <label htmlFor={id}>{label}</label>
      <div className="hw-scan-wrap">
        <ScanLine size={21} aria-hidden="true"/>
        <input
          ref={inputRef}
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onSubmit(); } }}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck="false"
          disabled={busy}
        />
        <button type="button" className="hw-camera" onClick={() => { setCameraError(''); setCameraOpen((current) => !current); }} aria-label="Open camera barcode scanner">
          <Camera size={18}/>
        </button>
      </div>
      <p>Scan the barcode or type the ID manually. A USB/Bluetooth scanner can enter the value directly.</p>
      {cameraOpen && <div className="hw-camera-panel"><video ref={videoRef} muted playsInline/><span>Align the barcode in the camera frame.</span><button type="button" onClick={() => setCameraOpen(false)}>Close scanner</button></div>}
      {cameraError && <div className="hw-field-error">{cameraError}</div>}
    </div>
  );
}

function StepProgress({ steps, active }) {
  return <div className="hw-progress" aria-label={`Step ${active + 1} of ${steps.length}`}>
    {steps.map((step, index) => <div key={step} className="hw-progress-step">
      <span className={index <= active ? 'active' : ''}>{index < active ? '✓' : index + 1}</span>
      <small>{step}</small>
    </div>)}
  </div>;
}

function SummaryRow({ label, value }) {
  return <div className="hw-summary-row"><span>{label}</span><strong>{value || '—'}</strong></div>;
}

function ConditionPicker({ physical, functional, onPhysical, onFunctional, notes, onNotes }) {
  return <div className="hw-condition">
    <div className="hw-condition-grid">
      <fieldset>
        <legend>Physical condition</legend>
        {['good', 'damaged'].map((value) => <label key={value} className={physical === value ? 'selected' : ''}>
          <input type="radio" name="hoto-physical" value={value} checked={physical === value} onChange={() => onPhysical(value)}/>
          <span>{pretty(value)}</span>
        </label>)}
      </fieldset>
      <fieldset>
        <legend>Functional condition</legend>
        {['working', 'not_working'].map((value) => <label key={value} className={functional === value ? 'selected' : ''}>
          <input type="radio" name="hoto-functional" value={value} checked={functional === value} onChange={() => onFunctional(value)}/>
          <span>{pretty(value)}</span>
        </label>)}
      </fieldset>
    </div>
    <label className="hw-notes">Remarks <span>Optional</span>
      <textarea value={notes} onChange={(event) => onNotes(event.target.value)} rows={2} placeholder="Add a short note only when required"/>
    </label>
  </div>;
}

export default function HotoWizard({ site, onComplete }) {
  const [screen, setScreen] = useState('shift');
  const [shift, setShift] = useState('');
  const [flow, setFlow] = useState('');
  const [worker, setWorker] = useState(null);
  const [toWorker, setToWorker] = useState(null);
  const [device, setDevice] = useState(null);
  const [currentHolder, setCurrentHolder] = useState(null);
  const [workerScan, setWorkerScan] = useState('');
  const [deviceScan, setDeviceScan] = useState('');
  const [targetScan, setTargetScan] = useState('');
  const [physical, setPhysical] = useState('good');
  const [functional, setFunctional] = useState('working');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState(null);
  const [overrideForm, setOverrideForm] = useState({ employee_id: '', employee_name: '', worker_type: 'GC', reason: '' });
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    setScreen('shift');
    setShift('');
    setFlow('');
    setWorker(null);
    setToWorker(null);
    setDevice(null);
    setCurrentHolder(null);
    setWorkerScan('');
    setDeviceScan('');
    setTargetScan('');
    setError('');
    setNotice('');
  }, [site]);

  const fail = (message) => {
    setError(message || 'The HOTO action could not be completed.');
    setNotice('');
  };
  const clearMessages = () => { setError(''); setNotice(''); };

  const resetTransaction = () => {
    setFlow('');
    setWorker(null);
    setToWorker(null);
    setDevice(null);
    setCurrentHolder(null);
    setWorkerScan('');
    setDeviceScan('');
    setTargetScan('');
    setPhysical('good');
    setFunctional('working');
    setNotes('');
    setError('');
    setNotice('');
    setDialog(null);
    setSuccess(null);
    setShift('');
    setScreen('shift');
  };

  const startFlow = (nextFlow) => {
    clearMessages();
    setFlow(nextFlow);
    setWorker(null);
    setToWorker(null);
    setDevice(null);
    setCurrentHolder(null);
    setWorkerScan('');
    setDeviceScan('');
    setTargetScan('');
    setPhysical('good');
    setFunctional('working');
    setNotes('');
    setScreen(nextFlow === 'handover' ? 'handover-worker' : 'device');
  };

  const validateWorker = async (rawId, target = false) => {
    const employeeId = text(rawId).toUpperCase();
    if (!employeeId) return fail('Scan or enter the GC / TL ID first.');
    setBusy(true);
    clearMessages();
    try {
      const result = await operationsApi.validateHotoWorker(employeeId, site, target ? 'mid_shift_swap' : 'handover');
      if (result?.valid && result?.available) {
        const candidate = { ...result.worker, manual_override: false };
        if (target) {
          if (currentHolder?.employee_id && candidate.employee_id?.toUpperCase() === currentHolder.employee_id.toUpperCase()) {
            fail('The receiving GC / TL is already the current holder. Scan a different GC / TL ID.');
            return;
          }
          setToWorker(candidate);
          setScreen('condition');
        } else {
          setWorker(candidate);
          setScreen('handover-device');
        }
        clearMessages();
      } else if (result?.valid && !result?.available) {
        const held = result.active_device || {};
        fail(`${result.worker?.employee_name || employeeId} is already holding another HHD (${held.serial || held.device_serial || 'device'}). One GC / TL can hold only one HHD at a time.`);
      } else {
        setOverrideForm({ employee_id: employeeId, employee_name: '', worker_type: 'GC', reason: '' });
        setDialog({ type: target ? 'override-target' : 'override-handover', title: 'GC / TL not found in HR master', message: result?.reason || `ID ${employeeId} is not an active record in the HR master for this site.` });
      }
    } catch (error) {
      fail(error.message || 'GC / TL validation failed.');
    } finally {
      setBusy(false);
    }
  };

  const acceptManualOverride = () => {
    const id = text(overrideForm.employee_id).toUpperCase();
    const name = text(overrideForm.employee_name);
    const reason = text(overrideForm.reason);
    const type = overrideForm.worker_type;
    if (!id || !name || !reason || !['GC', 'TL'].includes(type)) {
      fail('Enter the GC / TL ID, full name, worker type and override reason.');
      return;
    }
    const candidate = {
      employee_id: id,
      employee_name: name,
      worker_type: type,
      site_code: site,
      process: null,
      manual_override: true,
      override_reason: reason,
    };
    const target = dialog?.type === 'override-target';
    if (target) {
      if (currentHolder?.employee_id && id.toUpperCase() === currentHolder.employee_id.toUpperCase()) {
        fail('The receiving GC / TL cannot be the same person as the current holder.');
        return;
      }
      setToWorker(candidate);
      setScreen('condition');
    } else {
      setWorker(candidate);
      setScreen('handover-device');
    }
    setDialog(null);
    clearMessages();
  };

  const resolveDevice = async (rawValue, action) => {
    const scanValue = text(rawValue);
    if (!scanValue) return fail('Scan or enter the HHD IMEI / barcode first.');
    setBusy(true);
    clearMessages();
    try {
      const result = await operationsApi.resolveHotoDevice(scanValue, site, action);
      if (!result?.valid) {
        fail(result?.reason || 'HHD validation failed. Check the barcode and site.');
        return;
      }
      setDevice(result.device || result);
      setCurrentHolder(result.current_holder || null);
      if (action === 'handover') {
        if (result.requires_swap) {
          setDialog({
            type: 'handover-to-swap',
            title: 'HHD is currently with another GC / TL',
            message: `This HHD is currently held by ${result.current_holder?.employee_name || result.current_holder?.employee_id || 'another GC / TL'}. A direct handover is blocked. Use Mid-shift Swap to preserve the holder trail.`,
          });
          return;
        }
        setScreen('condition');
      } else if (action === 'takeover') {
        setScreen('condition');
      } else {
        setScreen('swap-worker');
      }
      clearMessages();
    } catch (error) {
      fail(error.message || 'HHD validation failed.');
    } finally {
      setBusy(false);
    }
  };

  const beginSwapFromHandover = () => {
    setFlow('swap');
    setToWorker(worker);
    setScreen('condition');
    setDialog(null);
    clearMessages();
  };

  const submitTransaction = async () => {
    if (!device?.serial) return fail('Device validation is required before confirmation.');
    if (flow === 'handover' && !worker) return fail('GC / TL validation is required before handover.');
    if (flow === 'swap' && !toWorker) return fail('Receiving GC / TL validation is required before swap.');
    if (flow !== 'takeover' && (physical !== 'good' || functional !== 'working')) {
      fail('A damaged or non-working HHD cannot be issued to a GC / TL. Use Takeover to receive it into IT quarantine, or resolve the device condition first.');
      return;
    }
    setBusy(true);
    clearMessages();
    try {
      let result;
      if (flow === 'takeover') {
        result = await operationsApi.takeoverHotoToIT({
          device_serial: device.serial,
          site_code: site,
          shift_code: shift,
          shift_date: localDate(),
          physical_condition: physical,
          functional_condition: functional,
          notes,
        });
      } else {
        const recipient = flow === 'handover' ? worker : toWorker;
        result = await operationsApi.recordHotoTransferV2({
          device_serial: device.serial,
          site_code: site,
          offroll_employee_id: recipient.employee_id,
          shift_code: shift,
          shift_date: localDate(),
          transaction_type: flow === 'swap' ? 'mid_shift_swap' : 'handover',
          physical_condition: physical,
          functional_condition: functional,
          notes,
          manual_override: Boolean(recipient.manual_override),
          manual_worker_name: recipient.manual_override ? recipient.employee_name : null,
          manual_worker_type: recipient.manual_override ? recipient.worker_type : null,
          override_reason: recipient.manual_override ? recipient.override_reason : null,
        });
      }
      setSuccess({ ...result, flow, timestamp: localDateTime(), physical_condition: physical, functional_condition: functional });
      setScreen('success');
      if (onComplete) await onComplete();
    } catch (error) {
      fail(error.message || 'HOTO transaction failed.');
    } finally {
      setBusy(false);
    }
  };

  const shiftSteps = flow === 'takeover' ? ['HHD', 'Condition'] : flow === 'swap' ? ['HHD', 'To GC / TL', 'Condition'] : ['GC / TL', 'HHD', 'Condition'];
  const activeStep = screen === 'handover-worker' ? 0
    : screen === 'handover-device' ? 1
    : screen === 'device' ? 0
    : screen === 'swap-worker' ? 1
    : screen === 'condition' ? shiftSteps.length - 1 : 0;

  const stepTitle = flow === 'takeover' ? 'TAKEOVER' : flow === 'swap' ? 'MID-SHIFT SWAP' : 'HANDOVER';
  const recipient = flow === 'handover' ? worker : toWorker;
  const deviceSummary = device && <div className="hw-device-summary">
    <div className="hw-device-icon"><Package size={22}/></div>
    <div className="hw-device-info"><small>HHD IDENTIFIED</small><strong>{device.serial}</strong><span>IMEI: {device.imei || 'Not recorded'} · {device.make || ''} {device.model || ''}</span></div>
  </div>;

  const backButton = (screenName, label = 'Back') => <button type="button" className="hw-back" onClick={() => { setScreen(screenName); clearMessages(); }}><ArrowLeft size={16}/>{label}</button>;
  const actionButton = (label, onClick, disabled = false) => <button type="button" className="hw-primary" onClick={onClick} disabled={busy || disabled}>{busy ? <RefreshCw className="hw-spin" size={17}/> : null}{label}<ArrowRight size={17}/></button>;

  return <div className="hw-shell">
    <header className="hw-header">
      <div className="hw-brand"><div className="hw-logo">H</div><div><strong>HHD CONTROL</strong><small>HANDOVER · TAKEOVER</small></div></div>
      <div className="hw-site"><Building2 size={15}/><span>{site}</span></div>
    </header>

    <main className="hw-main">
      {error && <div className="hw-alert hw-alert-error" role="alert"><AlertTriangle size={17}/><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {notice && <div className="hw-alert hw-alert-info"><BadgeCheck size={17}/><span>{notice}</span></div>}

      {screen === 'shift' && <section className="hw-entry">
        <div className="hw-eyebrow">SHIFT SETUP</div>
        <h1>Select your shift</h1>
        <p className="hw-subtitle">Choose the active shift to begin the HOTO process.</p>
        <div className="hw-shift-grid">
          {['A', 'B', 'C'].map((value) => <button key={value} type="button" className="hw-shift-card" onClick={() => { setShift(value); setScreen('process'); clearMessages(); }}>
            <strong>{value}</strong><span>SHIFT {value}</span><small>Select shift <ChevronRight size={13}/></small>
          </button>)}
        </div>
      </section>}

      {screen === 'process' && <section>
        <div className="hw-step-toolbar">{backButton('shift')}<span className="hw-chip">SHIFT {shift}</span></div>
        <div className="hw-eyebrow">CHOOSE OPERATION</div>
        <h1>What needs to be done?</h1>
        <p className="hw-subtitle">Choose one process for Shift {shift}. Only the selected workflow will open.</p>
        <div className="hw-process-grid">
          <button type="button" className="hw-process-card" onClick={() => startFlow('handover')}>
            <span className="hw-process-icon"><ArrowRight size={22}/></span><strong>Handover</strong><p>Issue an HHD to a GC / TL for the shift.</p><small>START HANDOVER <ArrowRight size={14}/></small>
          </button>
          <button type="button" className="hw-process-card" onClick={() => startFlow('takeover')}>
            <span className="hw-process-icon"><Package size={22}/></span><strong>Takeover</strong><p>Receive an HHD back from the current GC / TL into IT custody.</p><small>START TAKEOVER <ArrowRight size={14}/></small>
          </button>
          <button type="button" className="hw-process-card" onClick={() => startFlow('swap')}>
            <span className="hw-process-icon"><RefreshCw size={22}/></span><strong>Mid-shift swap</strong><p>Transfer an HHD from its current holder to another GC / TL.</p><small>START SWAP <ArrowRight size={14}/></small>
          </button>
        </div>
      </section>}

      {screen === 'handover-worker' && <section className="hw-flow">
        <StepProgress steps={shiftSteps} active={activeStep}/>
        <div className="hw-step-toolbar">{backButton('process')}<span className="hw-chip">SHIFT {shift} · HANDOVER</span></div>
        <div className="hw-eyebrow">STEP 1 · IDENTIFY RECIPIENT</div>
        <h1>Scan GC / TL ID</h1>
        <p className="hw-subtitle">The ID is checked against the site HR master. A worker must not already be holding another HHD.</p>
        <div className="hw-card">
          <HotoScanField id="hoto-worker-id" label="GC / TL ID" value={workerScan} onChange={setWorkerScan} placeholder="Scan or enter GC / TL ID" onSubmit={() => validateWorker(workerScan, false)} busy={busy}/>
          {actionButton('Validate GC / TL ID', () => validateWorker(workerScan, false), !text(workerScan))}
        </div>
      </section>}

      {screen === 'handover-device' && <section className="hw-flow">
        <StepProgress steps={shiftSteps} active={activeStep}/>
        <div className="hw-step-toolbar">{backButton('handover-worker')}<span className="hw-chip">SHIFT {shift} · HANDOVER</span></div>
        <div className="hw-eyebrow">STEP 2 · IDENTIFY DEVICE</div>
        <h1>Scan HHD IMEI</h1>
        <p className="hw-subtitle">Recipient verified. Scan the HHD to check its primary custodian, stock status and current holder.</p>
        <div className="hw-card">
          <div className="hw-person-summary"><UserRound size={19}/><div><small>VALIDATED GC / TL</small><strong>{worker?.employee_name} · {worker?.employee_id}</strong><span>{worker?.worker_type} · {worker?.site_code}{worker?.manual_override ? ' · Manual override' : ' · HR master'}</span></div></div>
          <HotoScanField id="hoto-handover-imei" label="HHD IMEI / Barcode" value={deviceScan} onChange={setDeviceScan} placeholder="Scan or enter HHD IMEI" onSubmit={() => resolveDevice(deviceScan, 'handover')} busy={busy}/>
          {actionButton('Validate HHD', () => resolveDevice(deviceScan, 'handover'), !text(deviceScan))}
        </div>
      </section>}

      {screen === 'device' && <section className="hw-flow">
        <StepProgress steps={shiftSteps} active={activeStep}/>
        <div className="hw-step-toolbar">{backButton('process')}<span className="hw-chip">SHIFT {shift} · {stepTitle}</span></div>
        <div className="hw-eyebrow">STEP 1 · IDENTIFY DEVICE</div>
        <h1>{flow === 'takeover' ? 'Scan HHD IMEI' : 'Scan HHD IMEI'}</h1>
        <p className="hw-subtitle">{flow === 'takeover' ? 'The current GC / TL holder will be identified automatically. Duplicate takeovers are blocked.' : 'Scan the HHD to identify its current GC / TL holder before selecting the recipient.'}</p>
        <div className="hw-card">
          <HotoScanField id="hoto-device-imei" label="HHD IMEI / Barcode" value={deviceScan} onChange={setDeviceScan} placeholder="Scan or enter HHD IMEI" onSubmit={() => resolveDevice(deviceScan, flow === 'takeover' ? 'takeover' : 'mid_shift_swap')} busy={busy}/>
          {actionButton(flow === 'takeover' ? 'Validate HHD for takeover' : 'Find current holder', () => resolveDevice(deviceScan, flow === 'takeover' ? 'takeover' : 'mid_shift_swap'), !text(deviceScan))}
        </div>
      </section>}

      {screen === 'swap-worker' && <section className="hw-flow">
        <StepProgress steps={shiftSteps} active={activeStep}/>
        <div className="hw-step-toolbar">{backButton('device')}<span className="hw-chip">SHIFT {shift} · MID-SHIFT SWAP</span></div>
        <div className="hw-eyebrow">STEP 2 · SELECT NEW HOLDER</div>
        <h1>Scan To GC / TL ID</h1>
        <p className="hw-subtitle">The current holder is already identified. Scan the receiving GC / TL and validate availability.</p>
        <div className="hw-card">
          {deviceSummary}
          <div className="hw-current-holder"><small>CURRENT HOLDER</small><strong>{currentHolder?.employee_name || currentHolder?.employee_id || 'GC / TL not identified'}</strong><span>{currentHolder?.employee_id || '—'}</span></div>
          <HotoScanField id="hoto-to-worker-id" label="Receiving GC / TL ID" value={targetScan} onChange={setTargetScan} placeholder="Scan or enter receiving GC / TL ID" onSubmit={() => validateWorker(targetScan, true)} busy={busy}/>
          {actionButton('Validate recipient', () => validateWorker(targetScan, true), !text(targetScan))}
        </div>
      </section>}

      {screen === 'condition' && <section className="hw-flow">
        <StepProgress steps={shiftSteps} active={activeStep}/>
        <div className="hw-step-toolbar">{backButton(flow === 'handover' ? 'handover-device' : flow === 'takeover' ? 'device' : 'swap-worker')}<span className="hw-chip">SHIFT {shift} · {stepTitle}</span></div>
        <div className="hw-eyebrow">FINAL STEP · DEVICE CONDITION</div>
        <h1>{flow === 'handover' ? 'Confirm handover condition' : flow === 'takeover' ? 'Confirm takeover condition' : 'Confirm swap condition'}</h1>
        <p className="hw-subtitle">Record the physical and functional condition before completing the transaction.</p>
        <div className="hw-card">
          {flow === 'handover' && <div className="hw-person-summary"><UserRound size={19}/><div><small>RECEIVING GC / TL</small><strong>{worker?.employee_name} · {worker?.employee_id}</strong><span>{worker?.worker_type}{worker?.manual_override ? ' · Manual override' : ' · HR master validated'}</span></div></div>}
          {flow === 'swap' && <>
            <div className="hw-current-holder"><small>PREVIOUS HOLDER</small><strong>{currentHolder?.employee_name || currentHolder?.employee_id}</strong><span>{currentHolder?.employee_id}</span></div>
            <div className="hw-person-summary"><UserRound size={19}/><div><small>RECEIVING GC / TL</small><strong>{toWorker?.employee_name} · {toWorker?.employee_id}</strong><span>{toWorker?.worker_type}{toWorker?.manual_override ? ' · Manual override' : ' · HR master validated'}</span></div></div>
          </>}
          {flow === 'takeover' && <div className="hw-current-holder"><small>RETURNED BY GC / TL</small><strong>{currentHolder?.employee_name || currentHolder?.employee_id || 'Current holder'}</strong><span>{currentHolder?.employee_id || '—'} · Destination: IT Department</span></div>}
          {deviceSummary}
          <ConditionPicker physical={physical} functional={functional} onPhysical={setPhysical} onFunctional={setFunctional} notes={notes} onNotes={setNotes}/>
          {flow !== 'takeover' && (physical !== 'good' || functional !== 'working') && <div className="hw-alert hw-alert-error"><ShieldAlert size={17}/><span>Damaged or non-working HHDs cannot be handed to a GC / TL. Use Takeover to return them to IT quarantine.</span></div>}
          {flow === 'takeover' && (physical !== 'good' || functional !== 'working') && <div className="hw-alert hw-alert-warn"><AlertTriangle size={17}/><span>This HHD will be received by IT into quarantine, not available stock.</span></div>}
          <div className="hw-confirm-meta"><span>Shift {shift}</span><span>Transaction date: {localDate()}</span><span>Time: captured automatically on save</span></div>
          {actionButton(`Confirm ${flow === 'swap' ? 'swap' : flow}`, submitTransaction, flow !== 'takeover' && (physical !== 'good' || functional !== 'working'))}
        </div>
      </section>}

      {screen === 'success' && <section className="hw-success">
        <div className="hw-success-icon"><CheckCircle2 size={31}/></div>
        <div className="hw-eyebrow">TRANSACTION RECORDED</div>
        <h1>{flow === 'handover' ? 'Handover completed' : flow === 'takeover' ? 'Takeover completed' : 'Mid-shift swap completed'}</h1>
        <p>{flow === 'handover' ? `HHD mapped to ${worker?.employee_name}.` : flow === 'takeover' ? 'HHD received into IT custody.' : `HHD transferred to ${toWorker?.employee_name}.`}</p>
        <div className="hw-success-card">
          <SummaryRow label="Reference" value={success?.hoto_id || 'Recorded'}/>
          <SummaryRow label="Shift" value={shift}/>
          <SummaryRow label="Process" value={flow === 'swap' ? 'Mid-shift swap' : pretty(flow)}/>
          <SummaryRow label="HHD Serial" value={success?.serial || device?.serial}/>
          <SummaryRow label="IMEI" value={device?.imei}/>
          <SummaryRow label="GC / TL" value={flow === 'takeover' ? currentHolder?.employee_name || currentHolder?.employee_id : (flow === 'handover' ? worker?.employee_name : toWorker?.employee_name)}/>
          <SummaryRow label="Condition" value={`${pretty(physical)} · ${pretty(functional)}`}/>
          <SummaryRow label="Date & time" value={success?.timestamp}/>
          <SummaryRow label="Validation" value={(worker?.manual_override || toWorker?.manual_override) ? 'Manual override recorded' : 'HR master validated'}/>
          {flow === 'takeover' && <SummaryRow label="IT stock result" value={physical === 'good' && functional === 'working' ? 'Available' : 'Quarantined'}/>}
        </div>
        <button type="button" className="hw-primary hw-primary-wide" onClick={resetTransaction}>Start another HOTO <ArrowRight size={17}/></button>
      </section>}
    </main>

    {dialog && <div className="hw-modal-backdrop" role="presentation">
      <section className="hw-modal" role="dialog" aria-modal="true" aria-labelledby="hw-dialog-title">
        <div className="hw-modal-icon">{dialog.type.startsWith('override') ? <ShieldAlert size={22}/> : <AlertTriangle size={22}/>}</div>
        <h2 id="hw-dialog-title">{dialog.title}</h2>
        <p>{dialog.message}</p>
        {dialog.type === 'handover-to-swap' && <div className="hw-modal-actions">
          <button type="button" className="hw-secondary" onClick={() => setDialog(null)}>Cancel</button>
          <button type="button" className="hw-primary" onClick={beginSwapFromHandover}>Continue as Mid-shift Swap <ArrowRight size={16}/></button>
        </div>}
        {dialog.type.startsWith('override') && <>
          <div className="hw-override-fields">
            <label>GC / TL ID<input value={overrideForm.employee_id} onChange={(event) => setOverrideForm((current) => ({ ...current, employee_id: event.target.value.toUpperCase() }))} placeholder="Enter ID"/></label>
            <label>GC / TL full name<input value={overrideForm.employee_name} onChange={(event) => setOverrideForm((current) => ({ ...current, employee_name: event.target.value }))} placeholder="Enter full name"/></label>
            <label>Worker type<select value={overrideForm.worker_type} onChange={(event) => setOverrideForm((current) => ({ ...current, worker_type: event.target.value }))}><option value="GC">GC</option><option value="TL">TL</option></select></label>
            <label>Override reason<textarea value={overrideForm.reason} onChange={(event) => setOverrideForm((current) => ({ ...current, reason: event.target.value }))} rows={2} placeholder="Why is HR master validation being overridden?"/></label>
          </div>
          <div className="hw-alert hw-alert-warn"><AlertTriangle size={16}/><span>Manual override will be recorded with operator, date/time and reason in the audit trail. This does not update the HR master.</span></div>
          <div className="hw-modal-actions">
            <button type="button" className="hw-secondary" onClick={() => setDialog(null)}>Cancel</button>
            <button type="button" className="hw-primary" onClick={acceptManualOverride}>Validate override <ArrowRight size={16}/></button>
          </div>
        </>}
      </section>
    </div>}
  </div>;
}
