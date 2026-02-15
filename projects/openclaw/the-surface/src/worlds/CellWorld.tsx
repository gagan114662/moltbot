import type { Mesh } from "three";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useRef } from "react";

/**
 * Inside a cell — biology portal.
 *
 * Translucent membrane, nucleus, mitochondria, floating particles.
 * "See that darker shape? That's the nucleus. It holds all the DNA."
 */

function CellMembrane() {
  return (
    <mesh>
      <sphereGeometry args={[3, 64, 64]} />
      <meshStandardMaterial
        color="#88c999"
        transparent
        opacity={0.15}
        roughness={0.9}
        side={2} // DoubleSide
      />
    </mesh>
  );
}

function Nucleus() {
  const ref = useRef<Mesh>(null!);
  useFrame((_, delta) => {
    ref.current.rotation.y += delta * 0.08;
  });

  return (
    <mesh ref={ref} position={[0.3, 0, 0.2]}>
      <sphereGeometry args={[0.9, 32, 32]} />
      <meshStandardMaterial color="#7b5ea7" roughness={0.7} metalness={0.1} />
      {/* Nucleolus */}
      <mesh position={[0.2, 0.1, 0.3]}>
        <sphereGeometry args={[0.25, 16, 16]} />
        <meshStandardMaterial color="#5a3d7a" roughness={0.8} />
      </mesh>
    </mesh>
  );
}

function Mitochondrion({ position, speed }: { position: [number, number, number]; speed: number }) {
  const ref = useRef<Mesh>(null!);
  const angle = useRef(Math.random() * Math.PI * 2);

  useFrame((_, delta) => {
    angle.current += delta * speed;
    ref.current.position.x = position[0] + Math.cos(angle.current) * 0.3;
    ref.current.position.z = position[2] + Math.sin(angle.current) * 0.3;
    ref.current.rotation.z += delta * 0.5;
  });

  return (
    <mesh ref={ref} position={position}>
      <capsuleGeometry args={[0.15, 0.4, 8, 16]} />
      <meshStandardMaterial color="#c44e52" roughness={0.6} />
    </mesh>
  );
}

function Particles({ count }: { count: number }) {
  const particles = useRef(
    Array.from({ length: count }, () => ({
      x: (Math.random() - 0.5) * 5,
      y: (Math.random() - 0.5) * 5,
      z: (Math.random() - 0.5) * 5,
      speed: 0.1 + Math.random() * 0.2,
    })),
  );

  return (
    <>
      {particles.current.map((p, i) => (
        <FloatingParticle key={i} initial={p} />
      ))}
    </>
  );
}

function FloatingParticle({
  initial,
}: {
  initial: { x: number; y: number; z: number; speed: number };
}) {
  const ref = useRef<Mesh>(null!);
  const offset = useRef(Math.random() * Math.PI * 2);

  useFrame((state) => {
    const t = state.clock.elapsedTime * initial.speed + offset.current;
    ref.current.position.x = initial.x + Math.sin(t) * 0.2;
    ref.current.position.y = initial.y + Math.cos(t * 0.7) * 0.15;
    ref.current.position.z = initial.z + Math.sin(t * 1.3) * 0.2;
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.03, 8, 8]} />
      <meshStandardMaterial color="#a8d8b9" transparent opacity={0.5} />
    </mesh>
  );
}

export function CellWorld() {
  return (
    <Canvas
      camera={{ position: [0, 1.5, 5], fov: 50 }}
      style={{ width: "100%", height: "100%", background: "#0d1f0d" }}
    >
      <ambientLight intensity={0.3} />
      <directionalLight position={[5, 5, 5]} intensity={0.8} color="#e8ffe8" />
      <pointLight position={[-3, -2, -3]} intensity={0.4} color="#7b5ea7" />

      <CellMembrane />
      <Nucleus />

      <Mitochondrion position={[1.5, 0.5, 1]} speed={0.4} />
      <Mitochondrion position={[-1.2, -0.3, 1.5]} speed={0.3} />
      <Mitochondrion position={[0.8, -0.8, -1.2]} speed={0.5} />
      <Mitochondrion position={[-0.5, 1, -0.8]} speed={0.35} />

      <Particles count={40} />

      <OrbitControls
        enablePan={false}
        enableZoom
        minDistance={2}
        maxDistance={10}
        autoRotate
        autoRotateSpeed={0.2}
      />
    </Canvas>
  );
}
