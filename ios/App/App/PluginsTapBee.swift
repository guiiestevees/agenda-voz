import Foundation
import AVFoundation
import Speech
import StoreKit
import Capacitor

// Tela principal do app: registra os plugins próprios do Tap Bee
class TapBeeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NuvemPlugin())
        bridge?.registerPluginInstance(VozPlugin())
        bridge?.registerPluginInstance(LojaPlugin())
    }
}

// ---------- iCloud: guarda uma cópia dos dados no iCloud de cada pessoa, sem login ----------
@objc(NuvemPlugin)
public class NuvemPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NuvemPlugin"
    public let jsName = "Nuvem"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ler", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "guardar", returnType: CAPPluginReturnPromise),
    ]
    private let loja = NSUbiquitousKeyValueStore.default
    private let chave = "dados"
    private let limite = 1_000_000   // o iCloud aceita até 1 MB aqui; os dados vão comprimidos

    public override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(mudou(_:)), name: NSUbiquitousKeyValueStore.didChangeExternallyNotification, object: loja)
        loja.synchronize()
    }

    @objc private func mudou(_ aviso: Notification) {
        let motivo = aviso.userInfo?[NSUbiquitousKeyValueStoreChangeReasonKey] as? Int ?? -1
        notifyListeners("mudou", data: ["cheio": motivo == NSUbiquitousKeyValueStoreQuotaViolationChange])
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(["conta": FileManager.default.ubiquityIdentityToken != nil])
    }

    @objc func ler(_ call: CAPPluginCall) {
        loja.synchronize()
        guard let dados = loja.data(forKey: chave) else { return call.resolve([:]) }
        guard let aberto = try? (dados as NSData).decompressed(using: .lzfse) as Data, let json = String(data: aberto, encoding: .utf8) else {
            return call.reject("Cópia do iCloud ilegível")
        }
        call.resolve(["json": json])
    }

    @objc func guardar(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), let dados = json.data(using: .utf8),
              let fechado = try? (dados as NSData).compressed(using: .lzfse) as Data else {
            return call.reject("Dados inválidos")
        }
        if fechado.count > limite { return call.reject("cheio") }
        loja.set(fechado, forKey: chave)
        loja.synchronize()
        call.resolve(["tamanho": fechado.count])
    }
}

// ---------- Voz: reconhecimento de fala do próprio iPhone para o botão Falar ----------
@objc(VozPlugin)
public class VozPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VozPlugin"
    public let jsName = "Voz"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "iniciar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "parar", returnType: CAPPluginReturnPromise),
    ]
    private let motor = AVAudioEngine()
    private var pedido: SFSpeechAudioBufferRecognitionRequest?
    private var tarefa: SFSpeechRecognitionTask?

    @objc func iniciar(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { fala in
            AVAudioSession.sharedInstance().requestRecordPermission { microfone in
                DispatchQueue.main.async {
                    guard fala == .authorized, microfone else { return call.reject("not-allowed") }
                    let idioma = call.getString("idioma") ?? "pt-BR"
                    do {
                        try self.comecar(idioma: idioma)
                        call.resolve()
                    } catch {
                        // O áudio do iPhone às vezes ainda está sendo trocado: tenta de novo em seguida
                        print("[Voz] primeira tentativa falhou: \(error)")
                        self.encerrar()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                            do {
                                try self.comecar(idioma: idioma)
                                call.resolve()
                            } catch {
                                print("[Voz] segunda tentativa falhou: \(error)")
                                self.encerrar()
                                call.reject("indisponivel: \(error.localizedDescription)")
                            }
                        }
                    }
                }
            }
        }
    }

    @objc func parar(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pedido?.endAudio()
            if self.motor.isRunning { self.motor.stop(); self.motor.inputNode.removeTap(onBus: 0) }
            call.resolve()
        }
    }

    private func comecar(idioma: String) throws {
        encerrar()
        guard let reconhecedor = SFSpeechRecognizer(locale: Locale(identifier: idioma)), reconhecedor.isAvailable else {
            throw NSError(domain: "Voz", code: 1)
        }
        let sessao = AVAudioSession.sharedInstance()
        try sessao.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
        try sessao.setActive(true, options: .notifyOthersOnDeactivation)

        let pedido = SFSpeechAudioBufferRecognitionRequest()
        pedido.shouldReportPartialResults = true
        self.pedido = pedido

        let entrada = motor.inputNode
        let formato = entrada.outputFormat(forBus: 0)
        guard formato.sampleRate > 0, formato.channelCount > 0 else { throw NSError(domain: "Voz", code: 2) }
        entrada.installTap(onBus: 0, bufferSize: 1024, format: formato) { buffer, _ in pedido.append(buffer) }
        motor.prepare()
        try motor.start()

        tarefa = reconhecedor.recognitionTask(with: pedido) { [weak self] resultado, erro in
            guard let self = self else { return }
            if let resultado = resultado {
                self.notifyListeners("resultado", data: ["texto": resultado.bestTranscription.formattedString, "final": resultado.isFinal])
            }
            if let erro = erro { print("[Voz] reconhecimento terminou com erro: \(erro)") }
            if erro != nil || resultado?.isFinal == true {
                DispatchQueue.main.async {
                    self.encerrar()
                    self.notifyListeners("fim", data: [:])
                }
            }
        }
    }

    private func encerrar() {
        if motor.isRunning { motor.stop() }
        motor.inputNode.removeTap(onBus: 0)
        pedido?.endAudio()
        tarefa?.cancel()
        pedido = nil
        tarefa = nil
        // Volta ao modo de reprodução: o som do Pomodoro continua com a tela bloqueada
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
    }
}

// ---------- Loja: pede a avaliação da App Store (o iOS decide se mostra) ----------
@objc(LojaPlugin)
public class LojaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LojaPlugin"
    public let jsName = "Loja"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "avaliar", returnType: CAPPluginReturnPromise),
    ]

    @objc func avaliar(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let cena = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene {
                SKStoreReviewController.requestReview(in: cena)
            }
            call.resolve()
        }
    }
}
