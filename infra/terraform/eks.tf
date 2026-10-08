# EKS skeleton: control plane + one managed node group. The app itself is deployed with
# Kubernetes manifests/Helm (not in this repo yet), running as ServiceAccount payments/payments-mcp.
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.29"

  name               = local.name
  kubernetes_version = var.kubernetes_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # Public API endpoint so you can run kubectl from your machine. In prod: private + VPN/bastion.
  endpoint_public_access                   = !local.is_prod
  enable_cluster_creator_admin_permissions = true

  addons = {
    coredns    = {}
    kube-proxy = {}
    vpc-cni = {
      before_compute = true
    }
    # Lets pods get AWS credentials from an IAM role (see iam.tf), with no keys in the cluster.
    eks-pod-identity-agent = {
      before_compute = true
    }
  }

  eks_managed_node_groups = {
    default = {
      ami_type       = "AL2023_x86_64_STANDARD"
      instance_types = var.node_instance_types
      min_size       = var.node_count.min
      desired_size   = var.node_count.desired
      max_size       = var.node_count.max
    }
  }
}
