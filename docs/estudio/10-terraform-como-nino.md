# Terraform explicado como a un niño (y cómo quedó en el código)

> **La idea:** en vez de entrar a la consola de AWS y hacer clic en 50 botones, **escribes una receta**
> de lo que quieres. Terraform la lee y construye todo. Si mañana lo necesitas igual en otra cuenta,
> usas la misma receta.

| Pieza | Analogía de niño | En el proyecto |
|---|---|---|
| **Archivos `.tf`** | La **lista de Legos** que quieres armar | `infra/terraform/*.tf` |
| **`terraform plan`** | **Mirar** la lista y decir qué piezas faltan, sin tocar nada | Muestra qué se va a crear/cambiar/borrar |
| **`terraform apply`** | **Armar** las piezas que faltan | Crea los recursos en AWS |
| **El estado (`tfstate`)** | La **foto** de lo que ya armaste, para saber qué cambió | En S3, con candado |
| **Módulo** | Un **kit de Legos ya diseñado** (la nave completa) | VPC y EKS de `terraform-aws-modules` |
| **Provider** | Las **instrucciones de la marca** para hablar con cada juguete | `hashicorp/aws` |

---

## 1. Por qué una receta y no clics

- **Se repite igual:** dev, staging y prod salen de la **misma receta** cambiando una variable.
- **Se revisa en un PR:** un cambio de infraestructura se ve como código (*"¿por qué abres este puerto?"*).
- **Se ve antes de hacerlo:** `plan` dice *"voy a borrar la base de datos"* **antes** de hacerlo.
- **Se puede deshacer:** `terraform destroy` borra todo lo que creó la receta, sin olvidar nada.

---

## 2. Las piezas que armamos

### 🗂️ La bandeja de avisos: SQS (`sqs.tf`)

**Como niño:** la **bandeja** donde el relay deja los avisos de pagos para que otros los lean.

- **Cola de errores (DLQ):** si un aviso **falla 5 veces**, se pasa a una bandeja aparte. Así no bloquea
  a los demás y alguien puede revisarlo después.
- **Long polling de 20 s:** el lector **espera un rato** a que llegue algo en vez de preguntar cada
  segundo *"¿hay algo?, ¿hay algo?"*. Menos llamadas, menos plata.
- **Cifrado:** los avisos se guardan cifrados.

Es **la misma configuración** que el `localstack/init-sqs.sh` de la tarea 7: lo que pruebas en local es
lo que corre en AWS.

### 🎫 El cuaderno de tickets: DynamoDB con TTL (`dynamodb.tf`)

**Como niño:** un cuaderno donde apuntas los **tickets de idempotencia** (*"este pedido ya lo
atendí"*). Cada hoja tiene **fecha de vencimiento**, y un ayudante **arranca solo las hojas vencidas**.

- **Llave:** `pk = MERCHANT#tienda_A`, `sk = KEY#abc123`. DynamoDB se diseña **por la pregunta que vas a
  hacer**: *"¿ya vi la clave abc123 de tienda_A?"*.
- **TTL en `expires_at`:** la app escribe *"vence en 24 h"* (en **segundos epoch**). DynamoDB las borra
  gratis. **Ojo:** puede tardar días en borrarlas, así que al leer también se revisa la fecha.
- **`PAY_PER_REQUEST`:** pagas por uso, sin adivinar capacidad.
- **PITR:** puedes volver la tabla a cualquier segundo de los últimos 35 días.

> 💬 *"La tabla ya existe en Terraform, pero la app todavía guarda las claves en Postgres. Es el paso
> siguiente del diseño: un `DynamoIdempotencyStore` que implementa la misma interfaz."*

### 🏘️ El barrio: la VPC (`network.tf`)

**Como niño:** un **barrio cerrado**.

- **Calles públicas:** donde está la **portería** (el load balancer que recibe a la gente).
- **Calles privadas:** donde viven las **casas** (los servidores y pods). Nadie de afuera llega directo.
- **NAT:** la **puerta de salida** para que las casas puedan salir (por ejemplo a SQS) sin que nadie entre.
  En dev hay **una** (cuesta ~32 USD/mes); en prod **una por zona**, para que si se cae una zona, las
  otras sigan saliendo.

### 🚢 El puerto de loncheras: EKS (`eks.tf`)

**Como niño:** Kubernetes es el **gerente** que reparte las **loncheras** (contenedores) entre los
**camiones** (servidores) y reemplaza las que se dañan. EKS es ese gerente, **administrado por AWS**.

- **Control plane:** el gerente (lo opera AWS).
- **Node group:** los camiones. Entre 1 y 3 `t3.medium`, normalmente 2.
- **Addons:** red de pods (`vpc-cni`), DNS interno (`coredns`), y el **agente de Pod Identity**.

Es un **esqueleto**: crea el cluster, pero todavía no despliega la app (faltan los manifests o Helm).

### 🔑 El permiso de la app: IAM + Pod Identity (`iam.tf`)

**Como niño:** a la app le das una **llave que solo abre dos puertas**: dejar avisos en **esa** bandeja
y escribir en **ese** cuaderno. Nada más. Eso es **mínimo privilegio**.

**¿Y dónde se guarda la llave?** En ningún lado. Con **Pod Identity**, Kubernetes le dice a AWS *"este
pod es la app de pagos"* y AWS le da credenciales **temporales**. No hay contraseñas de AWS en variables
de entorno ni en secretos.

---

## 3. La foto con candado: el estado remoto

**Como niño:** Terraform guarda una **foto** de lo que ya armó (`terraform.tfstate`). Si dos personas
arman al mismo tiempo con fotos distintas, rompen los Legos.

- La foto va en **S3** (no en tu computador), para que todo el equipo use la misma.
- **Candado:** mientras uno arma, el otro espera. Desde Terraform 1.10 el candado es un **archivo en el
  mismo bucket** (`use_lockfile = true`); antes hacía falta una tabla de DynamoDB solo para eso.
- El estado puede tener datos sensibles: va **cifrado** y **nunca** en Git (está en `.gitignore`).

En el proyecto el backend está **comentado**, para que `terraform init` funcione sin cuenta de AWS.

---

## 4. Cómo se usa

```bash
npm run tf:validate              # revisa formato y que la receta tenga sentido (no toca AWS)

cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan                   # mira qué se va a crear
terraform apply                  # lo crea (¡cuesta plata!)
terraform output sqs_queue_url   # lo que la app necesita
terraform destroy                # bórralo todo al terminar
```

> ⚠️ **Plata:** solo el control plane de EKS cuesta ~73 USD al mes, más los nodos y el NAT. **No lo
> dejes prendido.** SQS y DynamoDB con poco tráfico cuestan casi nada.

---

## 5. Preguntas probables (qué → por qué → ejemplo)

**¿Qué es Terraform y por qué usarlo?**
> "Es infraestructura como código: describo lo que quiero y Terraform calcula la diferencia con lo que
> existe. Lo uso porque es repetible entre entornos, se revisa en un PR y `plan` me muestra el impacto
> antes de aplicar. En el proyecto creo la cola SQS con su DLQ, la tabla DynamoDB con TTL y un cluster EKS."

**¿Qué es el state y cómo lo manejas en equipo?**
> "Es lo que Terraform sabe que ya creó. En equipo va en un backend remoto, S3 cifrado, con bloqueo para
> que dos `apply` no choquen. Desde la 1.10 el bloqueo es un lock file en el bucket. Nunca va en Git."

**¿Módulos propios o de la comunidad?**
> "Para VPC y EKS uso los módulos oficiales de `terraform-aws-modules`, fijados a una versión mayor:
> tienen miles de usuarios y resuelven detalles que yo olvidaría. Lo específico del negocio, como la
> cola, la tabla y los permisos, lo escribo directo."

**¿Cómo le das permisos a la app en EKS?**
> "Con EKS Pod Identity: el ServiceAccount de la app se asocia a un rol IAM con mínimo privilegio. Solo
> `SendMessage` en la cola y lectura/escritura de ítems en la tabla. No hay llaves de AWS en el cluster."

**¿Por qué TTL en DynamoDB para idempotencia?**
> "Las claves solo sirven unas horas. Con TTL se borran solas y gratis, en vez de tener un job de
> limpieza en Postgres. Como el borrado puede tardar, al leer también reviso `expires_at`."

**¿Cómo evitas que un `apply` rompa producción?**
> "Reviso el `plan` en el PR antes de aplicar. Además, en prod activo protecciones con una variable:
> deletion protection en DynamoDB, un NAT por zona y el endpoint de EKS privado."

**¿Lo aplicaste?**
> "Lo validé con `terraform validate`, pero no lo apliqué contra una cuenta real. Prefiero decirlo así
> a inventar que lo tengo corriendo."
